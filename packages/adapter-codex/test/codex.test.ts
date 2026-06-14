import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginCtx } from "@michaelfromyeg/weft-adapter-kit";
import type { Component, Plugin } from "@michaelfromyeg/weft-schema";
import { describe, expect, it } from "vitest";
import codexAdapter from "../src/index";
import { mcpRunConfig, mcpServerName } from "../src/mcp";

const SERVER_JSON = JSON.stringify({
  name: "com.acme/weather",
  description: "Weather server.",
  version: "1.0.0",
  packages: [{ registryType: "npm", identifier: "@acme/weather-mcp", version: "1.0.0" }],
});

const files: Record<string, string> = {
  "skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Review code.\n---\nBody.",
  "skills/code-review/reference.md": "extra asset",
  "agents/triage.md": "---\nname: triage\ndescription: Triage issues.\n---\nDo the triage.",
  "mcp/weather/server.json": SERVER_JSON,
};

const plugin: Plugin = {
  name: "sample-plugin",
  version: "0.1.0",
  owner: { name: "Acme", namespace: "com.acme", email: "a@acme.example" },
  description: "Sample.",
  components: [
    { skill: "skills/code-review" },
    { agent: "agents/triage.md" },
    { mcp: "mcp/weather" },
  ],
};

const ctx: PluginCtx = {
  plugin,
  read: (p) => Buffer.from(files[p] ?? "", "utf8"),
  list: (dir) =>
    Object.keys(files)
      .filter((f) => f.startsWith(`${dir}/`))
      .sort(),
  aliasFor: (id) => id,
};

describe("mcp run config derivation", () => {
  it("maps an npm package to npx", () => {
    expect(mcpRunConfig(JSON.parse(SERVER_JSON))).toEqual({
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.0.0"],
    });
  });

  it("maps a remote server to a url-only config (no transport key)", () => {
    expect(mcpRunConfig({ remotes: [{ type: "sse", url: "https://x/mcp" }] })).toEqual({
      url: "https://x/mcp",
    });
  });

  it("shortens the reverse-DNS server name", () => {
    expect(mcpServerName({ name: "com.acme/weather" })).toBe("weather");
  });
});

describe("codex adapter detect", () => {
  it("places skills on the shared .agents/skills path for user scope", () => {
    const paths = codexAdapter.detect("user", "/proj");
    expect(paths.root).toBe(join(homedir(), ".codex"));
    expect(paths.skills).toBe(join(homedir(), ".agents", "skills"));
    expect(paths.mcp).toBe(join(homedir(), ".codex"));
  });

  it("places skills on the project .agents/skills path for project scope", () => {
    const paths = codexAdapter.detect("project", "/proj");
    expect(paths.root).toBe(join("/proj", ".codex"));
    expect(paths.skills).toBe(join("/proj", ".agents", "skills"));
  });
});

describe("codex adapter transform", () => {
  it("copies a skill dir verbatim and adds an openai.yaml sidecar", () => {
    const arts = codexAdapter.transform({ skill: "skills/code-review" } as Component, ctx);
    const paths = arts.map((a) => a.relPath).sort();
    expect(paths).toEqual([
      "skills/code-review/SKILL.md",
      "skills/code-review/agents/openai.yaml",
      "skills/code-review/reference.md",
    ]);
    const sidecar = arts
      .find((a) => a.relPath === "skills/code-review/agents/openai.yaml")
      ?.contents.toString();
    expect(sidecar).toContain('display_name: "code-review"');
    expect(sidecar).toContain('short_description: "Review code."');
    expect(sidecar).toContain("allow_implicit_invocation: true");
    expect(sidecar).toContain("tools: []");
  });

  it("renders a subagent as agents/<leaf>.toml", () => {
    const arts = codexAdapter.transform({ agent: "agents/triage.md" } as Component, ctx);
    expect(arts).toHaveLength(1);
    expect(arts[0].relPath).toBe("agents/triage.toml");
    expect(arts[0].kind).toBe("agent");
    const toml = arts[0].contents.toString();
    expect(toml).toContain('name = "triage"');
    expect(toml).toContain('description = "Triage issues."');
    expect(toml).toContain("developer_instructions = ");
    expect(toml).toContain("Do the triage.");
  });

  it("copies an mcp dir verbatim under mcp/<leaf>/", () => {
    const arts = codexAdapter.transform({ mcp: "mcp/weather" } as Component, ctx);
    expect(arts.map((a) => a.relPath)).toEqual(["mcp/weather/server.json"]);
    expect(arts[0].kind).toBe("mcp");
  });
});

describe("codex adapter emitManifest", () => {
  it("emits .codex-plugin/plugin.json and a .mcp.json server map", () => {
    const arts = codexAdapter.emitManifest(plugin, ctx);

    const pluginJson = arts.find((a) => a.relPath === ".codex-plugin/plugin.json");
    expect(pluginJson).toBeDefined();
    const manifest = JSON.parse(pluginJson?.contents.toString() ?? "{}");
    expect(manifest).toMatchObject({
      name: "sample-plugin",
      version: "0.1.0",
      description: "Sample.",
      author: { name: "Acme", email: "a@acme.example" },
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });
    expect(manifest.interface).toEqual({
      displayName: "sample-plugin",
      shortDescription: "Sample.",
    });

    const mcpJson = arts.find((a) => a.relPath === ".mcp.json");
    expect(mcpJson).toBeDefined();
    const servers = JSON.parse(mcpJson?.contents.toString() ?? "{}");
    expect(servers.weather).toEqual({
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.0.0"],
    });
  });

  it("omits .mcp.json and the mcpServers field when there are no mcp components", () => {
    const noMcp: Plugin = { ...plugin, components: [{ skill: "skills/code-review" }] };
    const arts = codexAdapter.emitManifest(noMcp, ctx);
    expect(arts.find((a) => a.relPath === ".mcp.json")).toBeUndefined();
    const manifest = JSON.parse(
      arts.find((a) => a.relPath === ".codex-plugin/plugin.json")?.contents.toString() ?? "{}",
    );
    expect(manifest.mcpServers).toBeUndefined();
    expect(manifest.skills).toBe("./skills/");
  });
});

describe("codex adapter emitCatalog", () => {
  it("emits .agents/plugins/marketplace.json with local + git-subdir sources", () => {
    const arts = codexAdapter.emitCatalog({
      name: "sample-market",
      owner: plugin.owner,
      description: "Sample.",
      entries: [
        { name: "sample-plugin", source: "plugins/sample-plugin", category: "Productivity" },
        { name: "remote", source: "github:acme/remote#v1" },
      ],
    });
    expect(arts).toHaveLength(1);
    expect(arts[0].relPath).toBe(".agents/plugins/marketplace.json");
    expect(arts[0].kind).toBe("catalog");
    const catalog = JSON.parse(arts[0].contents.toString());
    expect(catalog.name).toBe("sample-market");
    expect(catalog.interface).toEqual({ displayName: "sample-market" });
    expect(catalog.plugins[0]).toEqual({
      name: "sample-plugin",
      source: { source: "local", path: "./plugins/sample-plugin" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
    expect(catalog.plugins[1]).toEqual({
      name: "remote",
      source: { source: "git-subdir", url: "https://github.com/acme/remote.git", ref: "v1" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
  });
});
