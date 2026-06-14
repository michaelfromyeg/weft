import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, build, importNativePlugin, lint } from "@michaelfromyeg/weft-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importCursor } from "../src/import";
import cursorAdapter from "../src/index";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "weft-cursor-import-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(path: string, contents: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

describe("importCursor round-trip", () => {
  it("builds the sample plugin to cursor, re-imports it, and lints clean", async () => {
    const pluginDir = fileURLToPath(new URL("../../../fixtures/sample-plugin", import.meta.url));
    const outDir = join(tmp, "build");
    await build({
      pluginDir,
      outDir,
      registry: new AdapterRegistry().register(cursorAdapter),
      targets: ["cursor"],
    });
    const builtPluginDir = join(outDir, "cursor", "plugins", "sample-plugin");

    // The built plugin keeps a verbatim mcp/weather/server.json, so the import uses it.
    const res = importCursor(builtPluginDir, { namespace: "com.acme" });
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.components).toEqual([
      { skill: "skills/code-review" },
      { mcp: "mcp/weather" },
    ]);
    expect(res.files.some((f) => f.relPath === "mcp/weather/server.json")).toBe(true);
    expect(res.files.some((f) => f.relPath === "skills/code-review/SKILL.md")).toBe(true);

    const weftOut = join(tmp, "reimported");
    importNativePlugin({
      dir: builtPluginDir,
      adapter: cursorAdapter,
      outDir: weftOut,
      namespace: "com.acme",
    });
    const linted = lint(weftOut);
    expect(linted.diagnostics.hasErrors).toBe(false);
    expect(linted.plugin.components.map((c) => Object.values(c)[0])).toEqual([
      "skills/code-review",
      "mcp/weather",
    ]);
  });
});

describe("importCursor plugin", () => {
  it("imports components and reconstructs server.json from each mcp run config", () => {
    const dir = join(tmp, "plugin");
    write(
      join(dir, ".cursor-plugin/plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.2.0",
        description: "d",
        author: { name: "A", email: "a@b.c" },
        mcpServers: {
          npmsrv: { command: "npx", args: ["-y", "@a/b@2.0.0"] },
          remote: { url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
          bare: { command: "node", args: ["s.js"], env: { K: "v" } },
        },
      }),
    );
    write(join(dir, "skills/greet/SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    write(join(dir, "agents/helper.md"), "agent");
    write(join(dir, "commands/do.md"), "cmd");

    const res = importCursor(dir, { namespace: "com.test" });
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.owner.namespace).toBe("com.test");
    expect(res.plugin.owner.email).toBe("a@b.c");
    expect(res.plugin.version).toBe("1.2.0");

    const file = (rel: string) => res.files.find((f) => f.relPath === rel);
    expect(file("skills/greet/SKILL.md")).toBeDefined();
    expect(file("agents/helper.md")).toBeDefined();
    expect(file("commands/do.md")).toBeDefined();

    const npm = JSON.parse(String(file("mcp/npmsrv/server.json")?.contents));
    expect(npm.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: "@a/b",
      version: "2.0.0",
    });
    // Cursor has no remote `type` discriminator; reconstruction defaults to streamable-http.
    const remote = JSON.parse(String(file("mcp/remote/server.json")?.contents));
    expect(remote.remotes[0]).toMatchObject({ type: "streamable-http", url: "https://x/mcp" });
    expect(remote.remotes[0].headers).toEqual([{ name: "Authorization", value: "Bearer t" }]);
    const bare = JSON.parse(String(file("mcp/bare/server.json")?.contents));
    expect(bare).toMatchObject({ command: "node", args: ["s.js"], env: { K: "v" } });
  });

  it("reads a verbatim mcp/<leaf>/server.json in preference to the native config", () => {
    const dir = join(tmp, "verbatim");
    write(
      join(dir, ".cursor-plugin/plugin.json"),
      JSON.stringify({
        name: "v",
        mcpServers: { stale: { command: "npx", args: ["-y", "@stale/pkg"] } },
      }),
    );
    write(
      join(dir, "mcp/weather/server.json"),
      JSON.stringify({ name: "com.acme/weather", version: "1.0.0" }),
    );
    const res = importCursor(dir, { namespace: "com.test" });
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.components).toEqual([{ mcp: "mcp/weather" }]);
    const server = res.files.find((f) => f.relPath === "mcp/weather/server.json");
    expect(JSON.parse(String(server?.contents)).name).toBe("com.acme/weather");
    // The stale native config must NOT have been reconstructed.
    expect(res.files.some((f) => f.relPath === "mcp/stale/server.json")).toBe(false);
  });

  it("reads mcpServers from mcp.json when the manifest omits them", () => {
    const dir = join(tmp, "mcpjson");
    write(join(dir, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "m" }));
    write(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { fromfile: { command: "go", args: ["run", "."] } } }),
    );
    const res = importCursor(dir);
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    const bare = JSON.parse(
      String(res.files.find((f) => f.relPath === "mcp/fromfile/server.json")?.contents),
    );
    expect(bare).toMatchObject({ command: "go", args: ["run", "."] });
  });

  it("imports a bare plugin layout with no manifest", () => {
    const dir = join(tmp, "bare");
    write(join(dir, "skills/x/SKILL.md"), "---\nname: x\ndescription: y\n---\nb");
    const res = importCursor(dir);
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.name).toBe("imported-plugin");
  });

  it("returns null when the directory is not a Cursor plugin", () => {
    const dir = join(tmp, "empty");
    mkdirSync(dir, { recursive: true });
    expect(importCursor(dir)).toBeNull();
  });
});

describe("importCursor marketplace", () => {
  it("maps every Cursor source form to a Weft source string", () => {
    const dir = join(tmp, "mkt");
    write(
      join(dir, ".cursor-plugin/marketplace.json"),
      JSON.stringify({
        name: "m",
        owner: { name: "O", email: "o@x" },
        metadata: { description: "md" },
        plugins: [
          { name: "a", source: "./plugins/a", version: "1.0.0", category: "c", tags: ["t"] },
          { name: "b", source: { source: "github", repo: "o/b", ref: "v1" } },
          { name: "c", source: { source: "url", url: "https://g/c.git" } },
          { name: "d", source: { source: "npm", package: "pkg", version: "1.0.0" } },
        ],
      }),
    );
    const res = importCursor(dir, { namespace: "com.test" });
    if (res?.kind !== "marketplace") throw new Error("expected a marketplace import");
    expect(res.marketplace.owner.namespace).toBe("com.test");
    expect(res.marketplace.plugins.map((p) => p.plugin)).toEqual([
      "./plugins/a",
      "github:o/b#v1",
      "https://g/c.git",
      "npm:pkg@1.0.0",
    ]);
    expect(res.marketplace.plugins[0]).toMatchObject({
      version: "1.0.0",
      category: "c",
      tags: ["t"],
    });
    // Description is read from the metadata wrapper.
    expect(res.marketplace.description).toBe("md");
  });
});
