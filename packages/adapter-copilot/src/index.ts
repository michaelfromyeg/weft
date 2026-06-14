import { homedir } from "node:os";
import { basename, join } from "node:path";
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
import { importCopilot } from "./import";
import { type McpServerConfig, mcpRunConfig, mcpServerName } from "./mcp";

/**
 * Bump on any change to Copilot's plugin/marketplace manifest shape (spec §5).
 * /2: catalog corrected to `.github/plugin/marketplace.json` with a `metadata` wrapper.
 *
 * NOTE for the future driver: Copilot has NO structured headless trace. `copilot -p`
 * only emits a markdown transcript via `--share`/`--share-gist`; `--output-format`/
 * `--json` exist only on `copilot mcp` subcommands. A driver must degrade `trace`
 * assertions to `output` assertions (research §Copilot).
 */
const TARGET_SCHEMA = "copilot-plugin/2";

interface CopilotAuthor {
  name: string;
  email?: string;
}
interface CopilotPluginManifest {
  name: string;
  description?: string;
  version?: string;
  author?: CopilotAuthor;
  mcpServers?: Record<string, McpServerConfig>;
}
interface CopilotMarketplacePlugin {
  name: string;
  source: string;
  description?: string;
  version?: string;
  category?: string;
  tags?: string[];
}
interface CopilotMarketplace {
  name: string;
  metadata?: { description?: string; version?: string };
  owner: CopilotAuthor;
  plugins: CopilotMarketplacePlugin[];
}

const json = (o: unknown): string => `${JSON.stringify(o, null, 2)}\n`;

function author(name: string, email?: string): CopilotAuthor {
  return email ? { name, email } : { name };
}

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

/** Place a component that may be a single Markdown file or a directory. */
function copyFileOrDir(
  ctx: PluginCtx,
  ref: string,
  destPrefix: string,
  ext: string,
  kind: CompiledArtifact["kind"],
): CompiledArtifact[] {
  const files = ctx.list(ref);
  if (files.length === 0) {
    // ref is a single file (e.g. agents/code-review.md). Use the harness-required
    // extension (e.g. .agent.md), not the source file's -- `destPrefix` already
    // ends in the extension-stripped leaf name.
    return [artifact(`${destPrefix}${ext}`, ctx.read(ref), { kind })];
  }
  return copyDir(ctx, ref, destPrefix, kind);
}

export const copilotAdapter: HarnessAdapter = {
  target: "copilot",
  version: "0.1.0",
  targetSchema: TARGET_SCHEMA,
  harness: {
    name: "Copilot CLI",
    versionCommand: "copilot --version",
    // Bump when the plugin/marketplace format is re-verified against a newer line.
    range: ">=0.1.0 <1.0.0",
  },

  detect(scope: Scope, cwd: string): InstallPaths {
    // Real Copilot keys its config dir off COPILOT_HOME (default ~/.copilot) and
    // has no official project scope. We honor COPILOT_HOME for user scope and treat
    // project scope as <cwd>/.copilot best-effort.
    // TODO(verify): project-scoped <cwd>/.copilot is unconfirmed -- Copilot only
    // documents COPILOT_HOME (no per-project config dir and no --config-dir flag).
    const userRoot = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
    const root = scope === "user" ? userRoot : join(cwd, ".copilot");
    return {
      root,
      plugins: join(root, "installed-plugins"),
      skills: join(root, "skills"),
      // mcp-config.json lives at the config-dir root, so `mcp` points at root.
      mcp: root,
      agents: join(root, "agents"),
      // TODO(verify): commands/ dir is best-effort; Copilot docs list skills/agents/
      // hooks/mcp-config.json but do not confirm a top-level commands/ directory.
      commands: join(root, "commands"),
      hooks: join(root, "hooks"),
      // The marketplace catalog is a repo artifact at `.github/plugin/` (CONFIRMED
      // against github/copilot-plugins), independent of the install scope root.
      catalog: join(cwd, ".github", "plugin"),
    };
  },

  transform(component: Component, ctx: PluginCtx): CompiledArtifact[] {
    const ref = refOf(component);
    const leaf = leafNameOf(component);
    switch (kindOf(component)) {
      case "skill":
        // skills/<name>/SKILL.md (+ any sibling assets), copied verbatim.
        return copyDir(ctx, ref, `skills/${leaf}`, "skill");
      case "agent":
        // CONFIRMED extension: agents/<name>.agent.md.
        return copyFileOrDir(ctx, ref, `agents/${leaf}`, ".agent.md", "agent");
      case "command":
        // TODO(verify): commands/<leaf>.md placement is best-effort (see detect()).
        return copyFileOrDir(ctx, ref, `commands/${leaf}`, ".md", "command");
      case "hook":
        return copyFileOrDir(ctx, ref, `hooks/${leaf}`, ".md", "hook");
      case "mcp":
        // Verbatim provenance copy; the runnable config goes inline in plugin.json.
        return copyDir(ctx, ref, `mcp/${leaf}`, "mcp");
      case "passthrough":
        return [
          artifact(`hooks/${basename(ref)}`, ctx.read(ref), { kind: "hook", executable: true }),
        ];
      default:
        return [];
    }
  },

  emitManifest(plugin: Plugin, ctx: PluginCtx): CompiledArtifact[] {
    const manifest: CopilotPluginManifest = {
      name: plugin.name,
      version: plugin.version,
      author: author(plugin.owner.name, plugin.owner.email),
    };
    if (plugin.description) manifest.description = plugin.description;

    const mcpServers: Record<string, McpServerConfig> = {};
    for (const c of plugin.components) {
      if (kindOf(c) !== "mcp") continue;
      try {
        const server = JSON.parse(ctx.read(`${refOf(c)}/server.json`).toString("utf8"));
        mcpServers[mcpServerName(server)] = mcpRunConfig(server);
      } catch {
        // validate.ts already surfaced an error for an unparsable server.json.
      }
    }
    if (Object.keys(mcpServers).length > 0) manifest.mcpServers = mcpServers;

    // plugin.json AT PLUGIN ROOT -- one of Copilot's four search locations
    // (.plugin/, root, .github/plugin/, .claude-plugin/).
    return [artifact("plugin.json", json(manifest), { kind: "manifest" })];
  },

  emitCatalog(marketplace: ResolvedMarketplace): CompiledArtifact[] {
    const plugins: CopilotMarketplacePlugin[] = marketplace.entries.map((entry) => {
      const entryPlugin: CopilotMarketplacePlugin = {
        name: entry.name,
        source: entry.source.startsWith("./") ? entry.source : `./${entry.source}`,
      };
      if (entry.description) entryPlugin.description = entry.description;
      if (entry.version) entryPlugin.version = entry.version;
      if (entry.category) entryPlugin.category = entry.category;
      if (entry.tags) entryPlugin.tags = entry.tags;
      return entryPlugin;
    });

    const catalog: CopilotMarketplace = {
      name: marketplace.name,
      owner: author(marketplace.owner.name, marketplace.owner.email),
      plugins,
    };
    // Marketplace-level description/version nest under `metadata` (NOT top-level).
    if (marketplace.description) catalog.metadata = { description: marketplace.description };

    // CONFIRMED (github/copilot-plugins): the catalog lives at
    // `.github/plugin/marketplace.json` -- `.github/plugin/` is Copilot's search
    // location, not `.copilot-plugin/`.
    return [artifact(".github/plugin/marketplace.json", json(catalog), { kind: "catalog" })];
  },

  importNative: importCopilot,
};

export default copilotAdapter;
