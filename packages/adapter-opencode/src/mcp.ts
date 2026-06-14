/**
 * Derives a runnable OpenCode `mcp` entry from an MCP-standard `server.json`
 * (the registry's ServerJSON shape: packages[] / remotes[] / a bare command).
 * Stored standards stay verbatim in the plugin; this is the tool-specific view.
 *
 * OpenCode's mcp shape differs from most harnesses (see docs/harness-research.md):
 *   local  -> { type: "local", command: [ ...string ARRAY... ], environment: {…}, enabled: true }
 *   remote -> { type: "remote", url, headers: {…}, enabled: true }
 * Note the local invocation is a single `command` STRING ARRAY (argv) and the
 * env key is `environment`, NOT `env`.
 */

interface OpencodeLocalServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled: boolean;
}
interface OpencodeRemoteServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled: boolean;
}
export type OpencodeMcpServer = OpencodeLocalServer | OpencodeRemoteServer;

interface McpPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: { type?: string };
}
interface McpRemote {
  type?: string;
  url?: string;
  headers?: Array<{ name: string; value: string }>;
}
interface ServerJson {
  name?: string;
  packages?: McpPackage[];
  remotes?: McpRemote[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The short server key OpenCode uses (the part after the reverse-DNS namespace). */
export function mcpServerName(server: ServerJson): string {
  const raw = server.name ?? "server";
  const afterSlash = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return afterSlash || "server";
}

// TODO(verify): the research doc only documents npx/local examples for OpenCode's
// command array. pypi/oci runner choice (uvx/docker) is a best-effort mirror of
// the other adapters and not confirmed against OpenCode docs.
const RUNNERS: Record<string, string> = { npm: "npx", pypi: "uvx" };

export function mcpRunConfig(server: ServerJson): OpencodeMcpServer {
  const pkg = server.packages?.[0];
  if (pkg?.identifier) {
    if (pkg.registryType === "oci") {
      return {
        type: "local",
        command: ["docker", "run", "-i", "--rm", pkg.identifier],
        enabled: true,
      };
    }
    const runner = RUNNERS[pkg.registryType ?? "npm"] ?? "npx";
    const ident = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
    const command = runner === "npx" ? ["npx", "-y", ident] : [runner, ident];
    return { type: "local", command, enabled: true };
  }

  const remote = server.remotes?.[0];
  if (remote?.url) {
    const config: OpencodeRemoteServer = { type: "remote", url: remote.url, enabled: true };
    if (remote.headers?.length) {
      config.headers = Object.fromEntries(remote.headers.map((h) => [h.name, h.value]));
    }
    return config;
  }

  if (server.command) {
    const config: OpencodeLocalServer = {
      type: "local",
      command: [server.command, ...(server.args ?? [])],
      enabled: true,
    };
    if (server.env) config.environment = server.env;
    return config;
  }

  return {
    type: "local",
    command: ["echo", "server.json declares no runnable transport"],
    enabled: true,
  };
}
