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
import { importClaude } from "./import";
import { type McpServerConfig, mcpRunConfig, mcpServerName } from "./mcp";

/** Bump on any change to Claude's plugin/marketplace manifest shape (spec §5). */
const TARGET_SCHEMA = "claude-code-plugin/2.1";

interface ClaudeAuthor {
  name: string;
  email?: string;
}
interface ClaudePluginManifest {
  name: string;
  description?: string;
  version?: string;
  author?: ClaudeAuthor;
  mcpServers?: Record<string, McpServerConfig>;
}
interface ClaudeMarketplacePlugin {
  name: string;
  source: string;
  description?: string;
  version?: string;
  category?: string;
  tags?: string[];
}
interface ClaudeMarketplace {
  name: string;
  owner: ClaudeAuthor;
  description?: string;
  plugins: ClaudeMarketplacePlugin[];
}

const json = (o: unknown): string => `${JSON.stringify(o, null, 2)}\n`;

function author(name: string, email?: string): ClaudeAuthor {
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
  kind: CompiledArtifact["kind"],
): CompiledArtifact[] {
  const files = ctx.list(ref);
  if (files.length === 0) {
    // ref is a single file (e.g. agents/code-review.md).
    return [artifact(`${destPrefix}${extname(ref) || ".md"}`, ctx.read(ref), { kind })];
  }
  return copyDir(ctx, ref, destPrefix, kind);
}

const claudeAdapter: HarnessAdapter = {
  target: "claude",
  version: "0.1.0",
  targetSchema: TARGET_SCHEMA,
  harness: {
    name: "Claude Code",
    versionCommand: "claude --version",
    // Bump when the plugin/marketplace format is re-verified against a newer line.
    range: ">=2.0.0 <3.0.0",
  },

  detect(scope: Scope, cwd: string): InstallPaths {
    const root = scope === "user" ? join(homedir(), ".claude") : join(cwd, ".claude");
    return {
      root,
      plugins: join(root, "plugins"),
      skills: join(root, "skills"),
      mcp: root,
      agents: join(root, "agents"),
      commands: join(root, "commands"),
      hooks: join(root, "hooks"),
      catalog: join(root, "plugins"),
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
        return copyFileOrDir(ctx, ref, `hooks/${leaf}`, "hook");
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
    const manifest: ClaudePluginManifest = {
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

    return [artifact(".claude-plugin/plugin.json", json(manifest), { kind: "manifest" })];
  },

  emitCatalog(marketplace: ResolvedMarketplace): CompiledArtifact[] {
    const plugins: ClaudeMarketplacePlugin[] = marketplace.entries.map((entry) => {
      const entryPlugin: ClaudeMarketplacePlugin = {
        name: entry.name,
        source: entry.source.startsWith("./") ? entry.source : `./${entry.source}`,
      };
      if (entry.description) entryPlugin.description = entry.description;
      if (entry.version) entryPlugin.version = entry.version;
      if (entry.category) entryPlugin.category = entry.category;
      if (entry.tags) entryPlugin.tags = entry.tags;
      return entryPlugin;
    });

    const catalog: ClaudeMarketplace = {
      name: marketplace.name,
      owner: author(marketplace.owner.name, marketplace.owner.email),
      plugins,
    };
    if (marketplace.description) catalog.description = marketplace.description;

    return [artifact(".claude-plugin/marketplace.json", json(catalog), { kind: "catalog" })];
  },

  importNative: importClaude,
};

export default claudeAdapter;
