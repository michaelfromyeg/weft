import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  artifact,
  type CompiledArtifact,
  type HarnessAdapter,
  type InstallPaths,
  type PluginCtx,
  type ResolvedMarketplace,
} from "@michaelfromyeg/weft-adapter-kit";
import {
  type Component,
  kindOf,
  leafNameOf,
  type Plugin,
  refOf,
  type Scope,
} from "@michaelfromyeg/weft-schema";
import { importOpencode } from "./import";
import { mcpRunConfig, mcpServerName, type OpencodeMcpServer } from "./mcp";

/** Bump on any change to OpenCode's directory-convention / opencode.json shape (spec §5). */
const TARGET_SCHEMA = "opencode/1";

interface OpencodeManifest {
  mcp: Record<string, OpencodeMcpServer>;
}
interface WeftMarketplacePlugin {
  name: string;
  source: string;
  description?: string;
  version?: string;
  category?: string;
  tags?: string[];
}
interface WeftMarketplace {
  name: string;
  owner: { name: string; namespace: string; email?: string };
  description?: string;
  plugins: WeftMarketplacePlugin[];
}

const json = (o: unknown): string => `${JSON.stringify(o, null, 2)}\n`;

/** Copy every file under a plugin dir into `destPrefix/`, preserving structure. */
function copyDir(
  ctx: PluginCtx,
  ref: string,
  destPrefix: string,
  kind: CompiledArtifact["kind"],
): CompiledArtifact[] {
  return ctx.list(ref).map((file) => {
    const within = file.startsWith(`${ref}/`) ? file.slice(ref.length + 1) : basename(file);
    return artifact(`${destPrefix}/${within}`, ctx.read(file), { kind });
  });
}

/**
 * Place a component that may be a single Markdown file or a directory. OpenCode
 * wants agents/commands as a flat `<leaf>.md`; a bare-file source falls back to
 * `.md`, while a directory source is copied verbatim under `destPrefix/`.
 */
function copyFileOrDir(
  ctx: PluginCtx,
  ref: string,
  destPrefix: string,
  kind: CompiledArtifact["kind"],
): CompiledArtifact[] {
  const files = ctx.list(ref);
  if (files.length === 0) {
    // ref is a single file (e.g. agents/code-review.md).
    return [artifact(`${destPrefix}${extname(ref) || ".md"}`, ctx.read(ref), { kind })];
  }
  return copyDir(ctx, ref, destPrefix, kind);
}

const opencodeAdapter: HarnessAdapter = {
  target: "opencode",
  version: "0.1.0",
  targetSchema: TARGET_SCHEMA,
  harness: {
    name: "OpenCode",
    versionCommand: "opencode --version",
    // OpenCode has no native marketplace; the agents/skills/mcp layout is stable
    // across the 0.x line. Bump when re-verified.
    range: ">=0.1.0 <1.0.0",
  },

  detect(scope: Scope, cwd: string): InstallPaths {
    // User config lives under XDG `~/.config/opencode`; project under `<cwd>/.opencode`.
    const root = scope === "user" ? join(homedir(), ".config", "opencode") : join(cwd, ".opencode");
    return {
      root,
      // Executable plugins (.ts) live in plugins/; that is also where passthrough lands.
      plugins: join(root, "plugins"),
      skills: join(root, "skills"),
      // opencode.json (with the mcp block) lives at the config root.
      mcp: root,
      agents: join(root, "agents"),
      commands: join(root, "commands"),
      hooks: join(root, "plugins"),
      catalog: root,
    };
  },

  transform(component: Component, ctx: PluginCtx): CompiledArtifact[] {
    const ref = refOf(component);
    const leaf = leafNameOf(component);
    switch (kindOf(component)) {
      case "skill":
        return copyDir(ctx, ref, `skills/${leaf}`, "skill");
      case "agent":
        return copyFileOrDir(ctx, ref, `agents/${leaf}`, "agent");
      case "command":
        return copyFileOrDir(ctx, ref, `commands/${leaf}`, "command");
      case "hook":
        // OpenCode has no standalone hooks dir; hooks are executable plugins.
        return [
          artifact(`plugins/${basename(ref)}`, ctx.read(ref), { kind: "hook", executable: true }),
        ];
      case "mcp":
        // Verbatim provenance copy; the runnable config goes into opencode.json's mcp block.
        return copyDir(ctx, ref, `mcp/${leaf}`, "mcp");
      case "passthrough":
        // Executable plugins/scripts land in plugins/, placed DISABLED (spec §11).
        return [
          artifact(`plugins/${basename(ref)}`, ctx.read(ref), { kind: "hook", executable: true }),
        ];
      default:
        return [];
    }
  },

  emitManifest(plugin: Plugin, ctx: PluginCtx): CompiledArtifact[] {
    // OpenCode has NO central plugin manifest. The only thing to emit is the
    // aggregated `mcp` block; on install this block is MERGED into the user's
    // existing opencode.json rather than replacing it.
    const mcp: Record<string, OpencodeMcpServer> = {};
    for (const c of plugin.components) {
      if (kindOf(c) !== "mcp") continue;
      try {
        const server = JSON.parse(ctx.read(`${refOf(c)}/server.json`).toString("utf8"));
        mcp[mcpServerName(server)] = mcpRunConfig(server);
      } catch {
        // validate.ts already surfaced an error for an unparsable server.json.
      }
    }
    if (Object.keys(mcp).length === 0) return [];

    const manifest: OpencodeManifest = { mcp };
    return [artifact("opencode.json", json(manifest), { kind: "manifest" })];
  },

  emitCatalog(marketplace: ResolvedMarketplace): CompiledArtifact[] {
    // OpenCode reads no marketplace catalog -- do NOT synthesize a manifest it
    // ignores. Emit a Weft-only index so the build output is inspectable; OpenCode
    // does not consume this file.
    const plugins: WeftMarketplacePlugin[] = marketplace.entries.map((entry) => {
      const entryPlugin: WeftMarketplacePlugin = {
        name: entry.name,
        source: entry.source.startsWith("./") ? entry.source : `./${entry.source}`,
      };
      if (entry.description) entryPlugin.description = entry.description;
      if (entry.version) entryPlugin.version = entry.version;
      if (entry.category) entryPlugin.category = entry.category;
      if (entry.tags) entryPlugin.tags = entry.tags;
      return entryPlugin;
    });

    const catalog: WeftMarketplace = {
      name: marketplace.name,
      owner: marketplace.owner,
      plugins,
    };
    if (marketplace.description) catalog.description = marketplace.description;

    return [artifact("weft-marketplace.json", json(catalog), { kind: "catalog" })];
  },

  importNative: importOpencode,
};

export default opencodeAdapter;
