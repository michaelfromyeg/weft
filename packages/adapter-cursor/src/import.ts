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

/** A Weft source string from a Cursor marketplace `source` (string or object). */
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

interface McpServerCfg {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Reconstruct an MCP-standard server.json from a Cursor `mcpServers` run config
 * (lossy but functional). Cursor has no `type` discriminator on a remote entry —
 * transport is inferred from `url` vs `command` — so a reconstructed remote
 * defaults to `streamable-http`.
 */
function synthesizeServerJson(namespace: string, name: string, cfg: McpServerCfg): unknown {
  const base = {
    $schema: MCP_SCHEMA,
    name: `${namespace}/${name}`,
    description: `Imported ${name} MCP server.`,
    version: "0.0.0",
  };
  if (cfg.url) {
    const remote: Record<string, unknown> = { type: "streamable-http", url: cfg.url };
    if (cfg.headers) {
      remote.headers = Object.entries(cfg.headers).map(([nm, value]) => ({ name: nm, value }));
    }
    return { ...base, remotes: [remote] };
  }
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
  for (const f of filesWithExt(join(dir, "agents"), ".md")) {
    components.push({ agent: `agents/${f}` });
    files.push(artifact(`agents/${f}`, readFileSync(join(dir, "agents", f)), { kind: "agent" }));
  }
  for (const f of filesWithExt(join(dir, "commands"), ".md")) {
    components.push({ command: `commands/${f}` });
    files.push(
      artifact(`commands/${f}`, readFileSync(join(dir, "commands", f)), { kind: "command" }),
    );
  }

  // Prefer a verbatim mcp/<leaf>/server.json (a Weft-built plugin keeps it); only
  // reconstruct from the native `mcpServers` config when there is no mcp/ dir.
  const mcpRoot = join(dir, "mcp");
  const verbatim = subdirsWith(mcpRoot, "server.json");
  if (verbatim.length > 0) {
    for (const leaf of verbatim) {
      components.push({ mcp: `mcp/${leaf}` });
      files.push(...copyTree(join(mcpRoot, leaf), `mcp/${leaf}`, "mcp"));
    }
  } else {
    const mcpServers =
      (manifest.mcpServers as Record<string, McpServerCfg> | undefined) ??
      (readJson(join(dir, "mcp.json"))?.mcpServers as Record<string, McpServerCfg>) ??
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

  const author = manifest.author as { name?: string; email?: string } | undefined;
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
  const owner = manifest.owner as { name?: string; email?: string } | undefined;
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

/** Reverse-compile a Cursor plugin or marketplace dir into the Weft model. */
export function importCursor(dir: string, opts?: ImportOptions): ImportResult | null {
  const namespace = opts?.namespace ?? "com.imported";
  const marketplace = readJson(join(dir, ".cursor-plugin", "marketplace.json"));
  if (marketplace) return importMarketplace(marketplace, namespace);

  const manifest =
    readJson(join(dir, ".cursor-plugin", "plugin.json")) ?? readJson(join(dir, "plugin.json"));
  if (manifest) return importPlugin(dir, manifest, namespace);

  // No manifest, but a bare plugin layout (skills/ etc.) is still importable.
  if (existsSync(join(dir, "skills"))) {
    return importPlugin(dir, { name: "imported-plugin" }, namespace);
  }
  return null;
}
