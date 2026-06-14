import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  artifact,
  type CompiledArtifact,
  type HarnessAdapter,
  type InstallPaths,
  type PluginCtx,
  parseFrontmatter,
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
import { importCodex } from "./import";
import { type McpServerConfig, mcpRunConfig, mcpServerName } from "./mcp";

/** Bump on any change to Codex's plugin/marketplace/sidecar shape (spec §5). */
const TARGET_SCHEMA = "codex-plugin/0.121";

const json = (o: unknown): string => `${JSON.stringify(o, null, 2)}\n`;

interface CodexAuthor {
  name: string;
  email?: string;
}
function author(name: string, email?: string): CodexAuthor {
  return email ? { name, email } : { name };
}

interface CodexPluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: CodexAuthor;
  /** Path to the skills dir, relative to the plugin root. */
  skills?: string;
  /** Path to the MCP server map (.mcp.json), relative to the plugin root. */
  mcpServers?: string;
  interface?: { displayName: string; shortDescription?: string };
}

interface CodexLocalSource {
  source: "local";
  path: string;
}
interface CodexGitSource {
  source: "git-subdir";
  url: string;
  path?: string;
  ref?: string;
}
interface CodexCatalogPlugin {
  name: string;
  source: CodexLocalSource | CodexGitSource;
  policy: { installation: string; authentication: string };
  category: string;
}
interface CodexMarketplace {
  name: string;
  interface: { displayName: string };
  plugins: CodexCatalogPlugin[];
}

/**
 * Map a resolved Weft entry source to Codex's discriminated source object. Local
 * relative paths become `{source:"local"}`; github/git URLs become
 * `{source:"git-subdir"}`. Codex resolves `path` relative to the repo root.
 */
function toCodexSource(source: string): CodexLocalSource | CodexGitSource {
  const gh = source.match(/^github:([^/#]+)\/([^#]+?)(?:#(.+))?$/);
  if (gh) {
    const [, owner, repoAndSub, ref] = gh;
    const slash = repoAndSub.indexOf("/");
    const repo = slash >= 0 ? repoAndSub.slice(0, slash) : repoAndSub;
    const sub = slash >= 0 ? repoAndSub.slice(slash + 1) : "";
    return {
      source: "git-subdir",
      url: `https://github.com/${owner}/${repo}.git`,
      ...(sub ? { path: `./${sub}` } : {}),
      ...(ref ? { ref } : {}),
    };
  }
  if (/^https?:\/\//.test(source) || source.endsWith(".git")) {
    return { source: "git-subdir", url: source };
  }
  return { source: "local", path: source.startsWith("./") ? source : `./${source}` };
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
    return [artifact(`${destPrefix}${extname(ref) || ".md"}`, ctx.read(ref), { kind })];
  }
  return copyDir(ctx, ref, destPrefix, kind);
}

/**
 * Read a skill's SKILL.md frontmatter so the sidecar can mirror its identity.
 * Returns empty data when there is no SKILL.md or no frontmatter block.
 */
function skillFrontmatter(ctx: PluginCtx, ref: string): Record<string, unknown> {
  try {
    const md = ctx.read(`${ref}/SKILL.md`).toString("utf8");
    return parseFrontmatter(md).data;
  } catch {
    return {};
  }
}

/**
 * Build the per-skill `agents/openai.yaml` sidecar. Shape is CONFIRMED in
 * harness-research.md: `interface.{display_name,short_description}`,
 * `policy.allow_implicit_invocation`, `dependencies.tools`.
 */
function skillSidecar(name: string, description: string): string {
  const yamlString = (v: string): string => JSON.stringify(v);
  return [
    "interface:",
    `  display_name: ${yamlString(name)}`,
    `  short_description: ${yamlString(description)}`,
    "policy:",
    "  allow_implicit_invocation: true",
    "dependencies:",
    "  tools: []",
    "",
  ].join("\n");
}

export const codexAdapter: HarnessAdapter = {
  target: "codex",
  version: "0.1.0",
  targetSchema: TARGET_SCHEMA,

  detect(scope: Scope, cwd: string): InstallPaths {
    const root = scope === "user" ? join(homedir(), ".codex") : join(cwd, ".codex");
    // User and project skills live on the SHARED `.agents/skills` path, NOT under
    // the `.codex` root (harness-research.md, Codex Skills section).
    const skills =
      scope === "user" ? join(homedir(), ".agents", "skills") : join(cwd, ".agents", "skills");
    return {
      root,
      plugins: join(root, "plugins"),
      skills,
      // config.toml (MCP servers) lives at the `.codex` root.
      mcp: root,
      agents: join(root, "agents"),
      // TODO(verify): Codex documents no dedicated commands dir; best-effort under root.
      commands: join(root, "commands"),
      // TODO(verify): Codex plugins reference hooks via a `hooks/hooks.json` manifest
      // path; this install-scope dir placement is best-effort and not wired to it.
      hooks: join(root, "hooks"),
      // Native marketplace catalog lives at `.agents/plugins/marketplace.json`
      // (shared `.agents` tree), NOT under the `.codex` root.
      catalog:
        scope === "user" ? join(homedir(), ".agents", "plugins") : join(cwd, ".agents", "plugins"),
    };
  },

  transform(component: Component, ctx: PluginCtx): CompiledArtifact[] {
    const ref = refOf(component);
    const leaf = leafNameOf(component);
    switch (kindOf(component)) {
      case "skill": {
        const files = copyDir(ctx, ref, `skills/${leaf}`, "skill");
        const fm = skillFrontmatter(ctx, ref);
        const displayName = typeof fm.name === "string" ? fm.name : leaf;
        const shortDescription = typeof fm.description === "string" ? fm.description : "";
        files.push(
          artifact(
            `skills/${leaf}/agents/openai.yaml`,
            skillSidecar(displayName, shortDescription),
            {
              kind: "skill",
            },
          ),
        );
        return files;
      }
      case "agent": {
        // Codex subagents are TOML files at agents/<leaf>.toml.
        // TODO(verify): exact subagent field set; documented fields are name,
        // description, developer_instructions (+ optional model/sandbox_mode/etc).
        const md = ctx.read(ref).toString("utf8");
        const { data, body } = parseFrontmatter(md);
        const name = typeof data.name === "string" ? data.name : leaf;
        const description = typeof data.description === "string" ? data.description : "";
        return [
          artifact(`agents/${leaf}.toml`, renderAgentToml(name, description, body), {
            kind: "agent",
          }),
        ];
      }
      case "command":
        // TODO(verify): no documented Codex commands dir; placed best-effort.
        return copyFileOrDir(ctx, ref, `commands/${leaf}`, "command");
      case "hook":
        // TODO(verify): Codex declares hooks via a `hooks/hooks.json` manifest; this
        // per-hook placement is best-effort and not yet wired into that file.
        return copyFileOrDir(ctx, ref, `hooks/${leaf}`, "hook");
      case "mcp":
        // Verbatim provenance copy; the runnable config goes into .mcp.json.
        return copyDir(ctx, ref, `mcp/${leaf}`, "mcp");
      case "passthrough":
        // TODO(verify): see the hook case; placed best-effort, disabled.
        return [
          artifact(`hooks/${basename(ref)}`, ctx.read(ref), { kind: "hook", executable: true }),
        ];
      default:
        return [];
    }
  },

  emitManifest(plugin: Plugin, ctx: PluginCtx): CompiledArtifact[] {
    const artifacts: CompiledArtifact[] = [];

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

    const hasSkills = plugin.components.some((c) => kindOf(c) === "skill");
    const hasMcp = Object.keys(mcpServers).length > 0;

    const manifest: CodexPluginManifest = {
      name: plugin.name,
      version: plugin.version,
      author: author(plugin.owner.name, plugin.owner.email),
    };
    if (plugin.description) manifest.description = plugin.description;
    // Auto-discovery covers the default layout; the explicit paths let Codex find
    // skills/MCP without scanning and make the bundle self-describing.
    if (hasSkills) manifest.skills = "./skills/";
    if (hasMcp) manifest.mcpServers = "./.mcp.json";
    manifest.interface = plugin.description
      ? { displayName: plugin.name, shortDescription: plugin.description }
      : { displayName: plugin.name };

    // The manifest MUST live under `.codex-plugin/` (Codex plugin spec, v0.121).
    artifacts.push(artifact(".codex-plugin/plugin.json", json(manifest), { kind: "manifest" }));
    // MCP servers go in a sibling `.mcp.json` (a direct name->config map) that the
    // manifest references -- Codex no longer reads a plugin-local config.toml.
    if (hasMcp) artifacts.push(artifact(".mcp.json", json(mcpServers), { kind: "manifest" }));

    return artifacts;
  },

  emitCatalog(marketplace: ResolvedMarketplace): CompiledArtifact[] {
    const plugins: CodexCatalogPlugin[] = marketplace.entries.map((entry) => ({
      name: entry.name,
      source: toCodexSource(entry.source),
      // Codex requires a policy; these defaults match its own example marketplaces.
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      // Codex requires a category; fall back to a valid default when unset.
      category: entry.category ?? "Productivity",
    }));

    const catalog: CodexMarketplace = {
      name: marketplace.name,
      interface: { displayName: marketplace.name },
      plugins,
    };

    return [artifact(".agents/plugins/marketplace.json", json(catalog), { kind: "catalog" })];
  },

  importNative: importCodex,
};

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render a Codex subagent TOML. Multi-line instructions use a basic string. */
function renderAgentToml(name: string, description: string, instructions: string): string {
  const lines = [`name = ${tomlString(name)}`];
  if (description) lines.push(`description = ${tomlString(description)}`);
  const body = instructions.trim();
  if (body) {
    const escaped = body.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
    lines.push(`developer_instructions = """\n${escaped}\n"""`);
  }
  return `${lines.join("\n")}\n`;
}

export default codexAdapter;
