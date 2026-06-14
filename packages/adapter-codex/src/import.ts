import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  artifact,
  type CompiledArtifact,
  type ImportedMarketplace,
  type ImportedPlugin,
  type ImportOptions,
  type ImportResult,
} from "@michaelfromyeg/weft-adapter-kit";
import type { Component, Marketplace, Plugin } from "@michaelfromyeg/weft-schema";

const MCP_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const json = (o: unknown): string => `${JSON.stringify(o, null, 2)}\n`;

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Subdirectories of `dir` that contain `marker`. */
function subdirsWith(dir: string, marker: string): string[] {
  if (!(existsSync(dir) && statSync(dir).isDirectory())) return [];
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, marker)))
    .sort();
}

function filesWithExt(dir: string, ext: string): string[] {
  if (!(existsSync(dir) && statSync(dir).isDirectory())) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(ext) && statSync(join(dir, n)).isFile())
    .sort();
}

function copyTree(
  srcDir: string,
  destPrefix: string,
  kind: CompiledArtifact["kind"],
): CompiledArtifact[] {
  const out: CompiledArtifact[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const abs = join(d, n);
      if (statSync(abs).isDirectory()) walk(abs);
      else
        out.push(artifact(`${destPrefix}/${relative(srcDir, abs)}`, readFileSync(abs), { kind }));
    }
  };
  walk(srcDir);
  return out;
}

/** A Weft source string from a Codex marketplace entry `source` object. */
function sourceToString(source: unknown): string {
  if (typeof source === "string") return source;
  const s = source as Record<string, unknown>;
  switch (s?.source) {
    case "local":
      return String(s.path ?? "");
    case "git-subdir": {
      const url = String(s.url ?? "");
      const gh = url.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
      if (gh) {
        const sub = typeof s.path === "string" ? s.path.replace(/^\.\//, "") : "";
        const ref = typeof s.ref === "string" ? s.ref : "";
        return `github:${gh[1]}/${gh[2]}${sub ? `/${sub}` : ""}${ref ? `#${ref}` : ""}`;
      }
      return url;
    }
    default:
      return String(source);
  }
}

interface McpServerCfg {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

/** Reconstruct an MCP-standard server.json from a Codex run config (lossy but functional). */
function synthesizeServerJson(namespace: string, name: string, cfg: McpServerCfg): unknown {
  const base = {
    $schema: MCP_SCHEMA,
    name: `${namespace}/${name}`,
    description: `Imported ${name} MCP server.`,
    version: "0.0.0",
  };
  if (cfg.url) return { ...base, remotes: [{ type: cfg.type ?? "streamable-http", url: cfg.url }] };
  if (cfg.command === "npx" && Array.isArray(cfg.args)) {
    const ident = cfg.args.find((a) => a !== "-y" && !a.startsWith("-"));
    if (ident) {
      const at = ident.lastIndexOf("@");
      const id = at > 0 ? ident.slice(0, at) : ident;
      const version = at > 0 ? ident.slice(at + 1) : undefined;
      return {
        ...base,
        packages: [
          {
            registryType: "npm",
            identifier: id,
            ...(version ? { version } : {}),
            transport: { type: "stdio" },
          },
        ],
      };
    }
  }
  return {
    ...base,
    ...(cfg.command ? { command: cfg.command } : {}),
    ...(cfg.args ? { args: cfg.args } : {}),
    ...(cfg.env ? { env: cfg.env } : {}),
  };
}

/**
 * Read a plugin's `.mcp.json` server map. Accepts both the direct
 * `{ "<name>": { command, args, ... } }` form Weft emits and the wrapped
 * `{ "mcp_servers": { ... } }` form Codex also documents.
 */
function readMcpJson(path: string): Record<string, McpServerCfg> {
  const parsed = readJson(path);
  if (!parsed) return {};
  const map =
    parsed.mcp_servers && typeof parsed.mcp_servers === "object"
      ? (parsed.mcp_servers as Record<string, unknown>)
      : parsed;
  const servers: Record<string, McpServerCfg> = {};
  for (const [name, cfg] of Object.entries(map)) {
    if (cfg && typeof cfg === "object") servers[name] = cfg as McpServerCfg;
  }
  return servers;
}

function importPlugin(
  dir: string,
  manifest: Record<string, unknown> | null,
  name: string,
  namespace: string,
): ImportedPlugin {
  const components: Component[] = [];
  const files: CompiledArtifact[] = [];

  // Skills: each skills/<name> dir with a SKILL.md. The per-skill
  // agents/openai.yaml sidecar inside is harness metadata, not a component; it
  // is carried along verbatim as a skill asset but never wired as an agent.
  for (const sk of subdirsWith(join(dir, "skills"), "SKILL.md")) {
    components.push({ skill: `skills/${sk}` });
    files.push(...copyTree(join(dir, "skills", sk), `skills/${sk}`, "skill"));
  }
  // Codex subagents are TOML files at agents/<file>.toml.
  for (const f of filesWithExt(join(dir, "agents"), ".toml")) {
    components.push({ agent: `agents/${f}` });
    files.push(artifact(`agents/${f}`, readFileSync(join(dir, "agents", f)), { kind: "agent" }));
  }

  // MCP: prefer the verbatim server.json copies a Weft build leaves under mcp/.
  // Only when there is no mcp/ dir do we reconstruct from the .mcp.json server map.
  const mcpDir = join(dir, "mcp");
  if (existsSync(mcpDir) && statSync(mcpDir).isDirectory()) {
    for (const leaf of subdirsWith(mcpDir, "server.json")) {
      components.push({ mcp: `mcp/${leaf}` });
      files.push(
        artifact(`mcp/${leaf}/server.json`, readFileSync(join(mcpDir, leaf, "server.json")), {
          kind: "mcp",
        }),
      );
    }
  } else if (existsSync(join(dir, ".mcp.json"))) {
    const servers = readMcpJson(join(dir, ".mcp.json"));
    for (const [serverName, cfg] of Object.entries(servers)) {
      components.push({ mcp: `mcp/${serverName}` });
      files.push(
        artifact(
          `mcp/${serverName}/server.json`,
          json(synthesizeServerJson(namespace, serverName, cfg)),
          { kind: "mcp" },
        ),
      );
    }
  }

  const author = manifest?.author as { name?: string; email?: string } | undefined;
  const plugin: Plugin = {
    name,
    version: String(manifest?.version ?? "0.1.0"),
    owner: {
      name: author?.name ?? name,
      namespace,
      ...(author?.email ? { email: author.email } : {}),
    },
    ...(manifest?.description ? { description: String(manifest.description) } : {}),
    components,
  };
  return { kind: "plugin", plugin, files };
}

function importMarketplace(
  manifest: Record<string, unknown>,
  namespace: string,
): ImportedMarketplace {
  // The Codex catalog has no owner; it carries `interface.displayName` instead.
  const iface = manifest.interface as { displayName?: string } | undefined;
  const ownerName = iface?.displayName ?? String(manifest.name);
  const plugins = ((manifest.plugins as Record<string, unknown>[]) ?? []).map((p) => ({
    plugin: sourceToString(p.source),
    ...(p.category ? { category: String(p.category) } : {}),
  }));
  const marketplace: Marketplace = {
    name: String(manifest.name),
    owner: { name: ownerName, namespace },
    plugins,
  };
  return { kind: "marketplace", marketplace };
}

/** Reverse-compile a Codex plugin or marketplace dir into the Weft model. */
export function importCodex(dir: string, opts?: ImportOptions): ImportResult | null {
  const namespace = opts?.namespace ?? "com.imported";

  // Native Codex marketplace catalog (shared `.agents` tree).
  const marketplace = readJson(join(dir, ".agents", "plugins", "marketplace.json"));
  if (marketplace) return importMarketplace(marketplace, namespace);

  const manifest = readJson(join(dir, ".codex-plugin", "plugin.json"));
  const basename = dir.replace(/\/+$/, "").split("/").pop() || "imported-plugin";
  const name = typeof manifest?.name === "string" ? manifest.name : basename;

  // A plugin is anything with the Codex component layout (manifest is best-effort).
  if (manifest || existsSync(join(dir, "skills")) || existsSync(join(dir, "agents"))) {
    return importPlugin(dir, manifest, name, namespace);
  }
  return null;
}
