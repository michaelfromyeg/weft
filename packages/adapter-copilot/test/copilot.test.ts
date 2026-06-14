import type { PluginCtx } from "@michaelfromyeg/weft-adapter-kit";
import type { Component, Plugin } from "@michaelfromyeg/weft-schema";
import { describe, expect, it } from "vitest";
import copilotAdapter from "../src/index";
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
  "agents/planner.md": "---\nname: planner\n---\nPlan things.",
  "mcp/weather/server.json": SERVER_JSON,
};

const plugin: Plugin = {
  name: "sample-plugin",
  version: "0.1.0",
  owner: { name: "Acme", namespace: "com.acme", email: "a@acme.example" },
  description: "Sample.",
  components: [{ skill: "skills/code-review" }, { mcp: "mcp/weather" }],
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
  it("maps an npm package to a local npx server with tools: *", () => {
    expect(mcpRunConfig(JSON.parse(SERVER_JSON))).toEqual({
      type: "local",
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.0.0"],
      tools: ["*"],
    });
  });

  it("maps an sse remote to an sse url config", () => {
    expect(mcpRunConfig({ remotes: [{ type: "sse", url: "https://x/mcp" }] })).toEqual({
      type: "sse",
      url: "https://x/mcp",
      tools: ["*"],
    });
  });

  it("maps a streamable-http remote to an http url config", () => {
    expect(mcpRunConfig({ remotes: [{ type: "streamable-http", url: "https://x/mcp" }] })).toEqual({
      type: "http",
      url: "https://x/mcp",
      tools: ["*"],
    });
  });

  it("shortens the reverse-DNS server name", () => {
    expect(mcpServerName({ name: "com.acme/weather" })).toBe("weather");
  });
});

describe("copilot adapter detect", () => {
  it("uses ~/.copilot for user scope and <cwd>/.copilot for project scope", () => {
    const user = copilotAdapter.detect("user", "/repo");
    expect(user.skills).toMatch(/\.copilot\/skills$/);
    expect(user.agents).toMatch(/\.copilot\/agents$/);
    expect(user.mcp).toBe(user.root);

    const project = copilotAdapter.detect("project", "/repo");
    expect(project.root).toBe("/repo/.copilot");
    expect(project.plugins).toBe("/repo/.copilot/installed-plugins");
  });
});

describe("copilot adapter transform", () => {
  it("copies a skill directory verbatim under skills/<leaf>/", () => {
    const arts = copilotAdapter.transform({ skill: "skills/code-review" } as Component, ctx);
    const paths = arts.map((a) => a.relPath).sort();
    expect(paths).toEqual(["skills/code-review/SKILL.md", "skills/code-review/reference.md"]);
    expect(arts.every((a) => a.kind === "skill")).toBe(true);
  });

  it("places a single-file agent at agents/<leaf>.agent.md", () => {
    const arts = copilotAdapter.transform({ agent: "agents/planner.md" } as Component, ctx);
    expect(arts).toHaveLength(1);
    expect(arts[0].relPath).toBe("agents/planner.agent.md");
    expect(arts[0].kind).toBe("agent");
  });

  it("copies an mcp dir verbatim as a provenance copy under mcp/<leaf>/", () => {
    const arts = copilotAdapter.transform({ mcp: "mcp/weather" } as Component, ctx);
    expect(arts.map((a) => a.relPath)).toEqual(["mcp/weather/server.json"]);
    expect(arts[0].kind).toBe("mcp");
  });
});

describe("copilot adapter emitManifest", () => {
  it("emits plugin.json at the plugin root with inline mcpServers", () => {
    const arts = copilotAdapter.emitManifest(plugin, ctx);
    expect(arts).toHaveLength(1);
    expect(arts[0].relPath).toBe("plugin.json");
    expect(arts[0].kind).toBe("manifest");

    const manifest = JSON.parse(arts[0].contents.toString());
    expect(manifest.name).toBe("sample-plugin");
    expect(manifest.author).toEqual({ name: "Acme", email: "a@acme.example" });
    expect(manifest.mcpServers.weather).toEqual({
      type: "local",
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.0.0"],
      tools: ["*"],
    });
  });
});

describe("copilot adapter emitCatalog", () => {
  it("emits .github/plugin/marketplace.json with a metadata wrapper and relative sources", () => {
    const arts = copilotAdapter.emitCatalog({
      name: "sample-plugin",
      owner: plugin.owner,
      description: "Sample.",
      entries: [
        { name: "sample-plugin", source: "./plugins/sample-plugin", version: "0.1.0" },
        { name: "other", source: "plugins/other", description: "Another." },
      ],
    });
    expect(arts[0].relPath).toBe(".github/plugin/marketplace.json");
    expect(arts[0].kind).toBe("catalog");

    const catalog = JSON.parse(arts[0].contents.toString());
    // Marketplace description nests under metadata, not at the top level.
    expect(catalog.metadata).toEqual({ description: "Sample." });
    expect(catalog.description).toBeUndefined();
    expect(catalog.owner).toEqual({ name: "Acme", email: "a@acme.example" });
    expect(catalog.plugins).toHaveLength(2);
    expect(catalog.plugins[0]).toMatchObject({
      name: "sample-plugin",
      source: "./plugins/sample-plugin",
      version: "0.1.0",
    });
    // bare sources get a "./" prefix (Copilot accepts both forms).
    expect(catalog.plugins[1].source).toBe("./plugins/other");
  });
});
