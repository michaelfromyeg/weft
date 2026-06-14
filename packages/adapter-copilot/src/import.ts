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
import type { McpServerConfig } from "./mcp";

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

/** A Weft source string from a Copilot marketplace `source` (string or object). */
function sourceToString(source: unknown): string {
  if (typeof source === "string") return source;
  const s = source as Record<string, unknown>;
  switch (s?.source) {
    case "github":
      return `github:${s.repo}${s.ref ? `#${s.ref}` : ""}`;
    case "url":
    case "git-subdir":
      return String(s.url);
    case "npm":
      return `npm:${s.package}${s.version ? `@${s.version}` : ""}`;
    default:
      return String(source);
  }
}

/**
 * Reconstruct an MCP-standard server.json from a Copilot `mcpServers` run config
 * (lossy but functional). Only used when there is NO verbatim mcp/<leaf>/server.json
 * to copy. Copilot's per-server shape: `type` local|stdio|http|sse; command/args/env
 * for local|stdio; url/headers for http|sse.
 */
function synthesizeServerJson(namespace: string, name: string, cfg: McpServerConfig): unknown {
  const base = {
    $schema: MCP_SCHEMA,
    name: `${namespace}/${name}`,
    description: `Imported ${name} MCP server.`,
    version: "0.0.0",
  };
  // Remote transport (http|sse + url).
  if (cfg.url) {
    const type = cfg.type === "sse" ? "sse" : "streamable-http";
    const headers =
      cfg.headers && Object.keys(cfg.headers).length
        ? Object.entries(cfg.headers).map(([n, value]) => ({ name: n, value }))
        : undefined;
    return {
      ...base,
      remotes: [{ type, url: cfg.url, ...(headers ? { headers } : {}) }],
    };
  }
  // npm-style local: command npx + a bare package identifier in args.
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
  // Bare local command.
  return {
    ...base,
    ...(cfg.command ? { command: cfg.command } : {}),
    ...(cfg.args ? { args: cfg.args } : {}),
    ...(cfg.env ? { env: cfg.env } : {}),
  };
}

function importPlugin(
  dir: string,
  manifest: Record<string, unknown>,
  namespace: string,
): ImportedPlugin {
  const components: Component[] = [];
  const files: CompiledArtifact[] = [];

  for (const sk of subdirsWith(join(dir, "skills"), "SKILL.md")) {
    components.push({ skill: `skills/${sk}` });
    files.push(...copyTree(join(dir, "skills", sk), `skills/${sk}`, "skill"));
  }
  // Copilot agents are agents/<name>.agent.md.
  for (const f of filesWithExt(join(dir, "agents"), ".agent.md")) {
    components.push({ agent: `agents/${f}` });
    files.push(artifact(`agents/${f}`, readFileSync(join(dir, "agents", f)), { kind: "agent" }));
  }
  for (const f of filesWithExt(join(dir, "commands"), ".md")) {
    components.push({ command: `commands/${f}` });
    files.push(
      artifact(`commands/${f}`, readFileSync(join(dir, "commands", f)), { kind: "command" }),
    );
  }

  // MCP: prefer a verbatim mcp/<leaf>/server.json (a Weft-built plugin carries one);
  // only reconstruct from the native run config when there is no mcp/ dir.
  if (existsSync(join(dir, "mcp"))) {
    for (const leaf of subdirsWith(join(dir, "mcp"), "server.json")) {
      components.push({ mcp: `mcp/${leaf}` });
      files.push(
        artifact(`mcp/${leaf}/server.json`, readFileSync(join(dir, "mcp", leaf, "server.json")), {
          kind: "mcp",
        }),
      );
    }
  } else {
    const mcpServers =
      (manifest.mcpServers as Record<string, McpServerConfig> | undefined) ??
      (readJson(join(dir, "mcp-config.json"))?.mcpServers as Record<string, McpServerConfig>) ??
      {};
    for (const [serverName, cfg] of Object.entries(mcpServers)) {
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

  const authorRaw = manifest.author;
  const author =
    typeof authorRaw === "string"
      ? { name: authorRaw }
      : (authorRaw as { name?: string; email?: string } | undefined);
  const plugin: Plugin = {
    name: String(manifest.name),
    version: String(manifest.version ?? "0.1.0"),
    owner: {
      name: author?.name ?? String(manifest.name),
      namespace,
      ...(author?.email ? { email: author.email } : {}),
    },
    ...(manifest.description ? { description: String(manifest.description) } : {}),
    components,
  };
  return { kind: "plugin", plugin, files };
}

function importMarketplace(
  manifest: Record<string, unknown>,
  namespace: string,
): ImportedMarketplace {
  const ownerRaw = manifest.owner;
  const owner =
    typeof ownerRaw === "string"
      ? { name: ownerRaw }
      : (ownerRaw as { name?: string; email?: string } | undefined);
  const plugins = ((manifest.plugins as Record<string, unknown>[]) ?? []).map((p) => ({
    plugin: sourceToString(p.source),
    ...(p.version ? { version: String(p.version) } : {}),
    ...(p.category ? { category: String(p.category) } : {}),
    ...(Array.isArray(p.tags) ? { tags: p.tags as string[] } : {}),
  }));
  // Marketplace-level description nests under `metadata` (top-level is the legacy form).
  const meta = manifest.metadata as { description?: string } | undefined;
  const description =
    meta?.description ?? (manifest.description ? String(manifest.description) : "");
  const marketplace: Marketplace = {
    name: String(manifest.name),
    owner: {
      name: owner?.name ?? String(manifest.name),
      namespace,
      ...(owner?.email ? { email: owner.email } : {}),
    },
    ...(description ? { description } : {}),
    plugins,
  };
  return { kind: "marketplace", marketplace };
}

/** Copilot's four plugin.json search locations (research §Copilot). */
const MANIFEST_PATHS = [
  ["plugin.json"],
  [".plugin", "plugin.json"],
  [".github", "plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
];

/** Reverse-compile a GitHub Copilot plugin or marketplace dir into the Weft model. */
export function importCopilot(dir: string, opts?: ImportOptions): ImportResult | null {
  const namespace = opts?.namespace ?? "com.imported";
  // `.github/plugin/` is Copilot's marketplace location; `.claude-plugin/` is the fallback.
  const marketplace =
    readJson(join(dir, ".github", "plugin", "marketplace.json")) ??
    readJson(join(dir, ".claude-plugin", "marketplace.json"));
  if (marketplace) return importMarketplace(marketplace, namespace);

  for (const segs of MANIFEST_PATHS) {
    const manifest = readJson(join(dir, ...segs));
    if (manifest) return importPlugin(dir, manifest, namespace);
  }

  // No manifest, but a bare plugin layout (skills/ etc.) is still importable.
  if (existsSync(join(dir, "skills"))) {
    return importPlugin(dir, { name: "imported-plugin" }, namespace);
  }
  return null;
}
