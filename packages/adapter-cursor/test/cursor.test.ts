import type { PluginCtx } from "@michaelfromyeg/weft-adapter-kit";
import type { Component, Plugin } from "@michaelfromyeg/weft-schema";
import { describe, expect, it } from "vitest";
import cursorAdapter from "../src/index";
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
  "agents/reviewer.md": "---\nname: reviewer\n---\nReview agent.",
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

describe("cursor mcp run config derivation", () => {
  it("maps an npm package to npx", () => {
    expect(mcpRunConfig(JSON.parse(SERVER_JSON))).toEqual({
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.0.0"],
    });
  });

  it("maps a remote server to a url config with no type discriminator", () => {
    expect(mcpRunConfig({ remotes: [{ type: "sse", url: "https://x/mcp" }] })).toEqual({
      url: "https://x/mcp",
    });
  });

  it("shortens the reverse-DNS server name", () => {
    expect(mcpServerName({ name: "com.acme/weather" })).toBe("weather");
  });
});

describe("cursor adapter detect", () => {
  it("roots user installs at ~/.cursor with mcp at root", () => {
    const paths = cursorAdapter.detect("user", "/work");
    expect(paths.skills.endsWith("/.cursor/skills")).toBe(true);
    expect(paths.mcp.endsWith("/.cursor")).toBe(true);
    expect(paths.mcp).toBe(paths.root);
  });

  it("roots project installs at <cwd>/.cursor", () => {
    const paths = cursorAdapter.detect("project", "/work");
    expect(paths.root).toBe("/work/.cursor");
    expect(paths.plugins).toBe("/work/.cursor/plugins");
    expect(paths.catalog).toBe("/work/.cursor/plugins");
  });
});

describe("cursor adapter transform", () => {
  it("copies a skill directory verbatim under skills/<leaf>/", () => {
    const arts = cursorAdapter.transform({ skill: "skills/code-review" } as Component, ctx);
    const paths = arts.map((a) => a.relPath).sort();
    expect(paths).toEqual(["skills/code-review/SKILL.md", "skills/code-review/reference.md"]);
    expect(arts.every((a) => a.kind === "skill")).toBe(true);
  });

  it("places a single-file agent under agents/<leaf>.md", () => {
    const arts = cursorAdapter.transform({ agent: "agents/reviewer.md" } as Component, ctx);
    expect(arts).toHaveLength(1);
    expect(arts[0].relPath).toBe("agents/reviewer.md");
    expect(arts[0].kind).toBe("agent");
  });

  it("copies an mcp directory verbatim as a provenance copy", () => {
    const arts = cursorAdapter.transform({ mcp: "mcp/weather" } as Component, ctx);
    expect(arts.map((a) => a.relPath)).toEqual(["mcp/weather/server.json"]);
    expect(arts[0].kind).toBe("mcp");
  });
});

describe("cursor adapter emitManifest", () => {
  it("emits .cursor-plugin/plugin.json with inline mcpServers aggregated from all mcp components", () => {
    const arts = cursorAdapter.emitManifest(plugin, ctx);
    expect(arts).toHaveLength(1);
    expect(arts[0].relPath).toBe(".cursor-plugin/plugin.json");
    expect(arts[0].kind).toBe("manifest");
    const manifest = JSON.parse(arts[0].contents.toString());
    expect(manifest.name).toBe("sample-plugin");
    expect(manifest.author).toEqual({ name: "Acme", email: "a@acme.example" });
    expect(manifest.mcpServers.weather).toEqual({
      command: "npx",
      args: ["-y", "@acme/weather-mcp@1.0.0"],
    });
  });
});

describe("cursor adapter emitCatalog", () => {
  it("emits .cursor-plugin/marketplace.json with bare sources and metadata-nested description", () => {
    const arts = cursorAdapter.emitCatalog({
      name: "sample-plugin",
      owner: plugin.owner,
      description: "Sample.",
      entries: [
        { name: "sample-plugin", source: "./plugins/sample-plugin", version: "0.1.0" },
        { name: "other", source: "plugins/other", description: "Another." },
      ],
    });
    expect(arts[0].relPath).toBe(".cursor-plugin/marketplace.json");
    expect(arts[0].kind).toBe("catalog");
    const catalog = JSON.parse(arts[0].contents.toString());
    // Description nests under metadata, not the top level.
    expect(catalog.metadata).toEqual({ description: "Sample." });
    expect(catalog.description).toBeUndefined();
    expect(catalog.owner).toEqual({ name: "Acme", email: "a@acme.example" });
    expect(catalog.plugins).toHaveLength(2);
    // Sources are bare repo-root-relative paths: a leading "./" is stripped.
    expect(catalog.plugins[0]).toMatchObject({
      name: "sample-plugin",
      source: "plugins/sample-plugin",
      version: "0.1.0",
    });
    expect(catalog.plugins[1].source).toBe("plugins/other");
  });
});
