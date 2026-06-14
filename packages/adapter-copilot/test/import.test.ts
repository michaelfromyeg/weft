import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry, build, importNativePlugin, lint } from "@michaelfromyeg/weft-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importCopilot } from "../src/import";
import copilotAdapter from "../src/index";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "weft-copilot-import-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(path: string, contents: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

describe("importCopilot round-trip", () => {
  it("imports a Weft-built copilot plugin back into a valid Weft plugin", async () => {
    const pluginDir = fileURLToPath(new URL("../../../fixtures/sample-plugin", import.meta.url));
    const outDir = join(tmp, "built");
    await build({
      pluginDir,
      outDir,
      registry: new AdapterRegistry().register(copilotAdapter),
      targets: ["copilot"],
    });
    const builtPluginDir = join(outDir, "copilot", "plugins", "sample-plugin");

    const res = importCopilot(builtPluginDir, { namespace: "com.acme" });
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.owner.namespace).toBe("com.acme");
    // The verbatim mcp/weather/server.json must be reused (not reconstructed).
    expect(res.files.find((f) => f.relPath === "mcp/weather/server.json")).toBeDefined();

    const weftOut = join(tmp, "weft-out");
    importNativePlugin({
      dir: builtPluginDir,
      adapter: copilotAdapter,
      outDir: weftOut,
      namespace: "com.acme",
    });
    const linted = lint(weftOut);
    expect(linted.diagnostics.hasErrors).toBe(false);
    const refs = linted.plugin.components.map((c) => Object.values(c)[0]);
    expect(refs).toContain("skills/code-review");
    expect(refs).toContain("mcp/weather");
  });
});

describe("importCopilot plugin", () => {
  it("imports components and reconstructs server.json from each mcp run config", () => {
    const dir = join(tmp, "plugin");
    write(
      join(dir, ".plugin/plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.2.0",
        description: "d",
        author: { name: "A", email: "a@b.c" },
        mcpServers: {
          npmsrv: { type: "local", command: "npx", args: ["-y", "@a/b@2.0.0"] },
          remote: { type: "sse", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
          httpsrv: { type: "http", url: "https://y/mcp" },
          bare: { type: "stdio", command: "node", args: ["s.js"], env: { K: "v" } },
        },
      }),
    );
    write(join(dir, "skills/greet/SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    write(join(dir, "agents/helper.agent.md"), "agent");
    write(join(dir, "commands/do.md"), "cmd");

    const res = importCopilot(dir, { namespace: "com.test" });
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.owner.namespace).toBe("com.test");
    expect(res.plugin.owner.email).toBe("a@b.c");
    expect(res.plugin.version).toBe("1.2.0");

    const file = (rel: string) => res.files.find((f) => f.relPath === rel);
    expect(file("skills/greet/SKILL.md")).toBeDefined();
    expect(file("agents/helper.agent.md")).toBeDefined();
    expect(file("commands/do.md")).toBeDefined();
    // The agent component ref keeps the full .agent.md leaf.
    expect(res.plugin.components).toContainEqual({ agent: "agents/helper.agent.md" });

    const npm = JSON.parse(String(file("mcp/npmsrv/server.json")?.contents));
    expect(npm.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: "@a/b",
      version: "2.0.0",
    });
    const remote = JSON.parse(String(file("mcp/remote/server.json")?.contents));
    expect(remote.remotes[0]).toMatchObject({ type: "sse", url: "https://x/mcp" });
    expect(remote.remotes[0].headers).toEqual([{ name: "Authorization", value: "Bearer t" }]);
    const http = JSON.parse(String(file("mcp/httpsrv/server.json")?.contents));
    expect(http.remotes[0]).toMatchObject({ type: "streamable-http", url: "https://y/mcp" });
    const bare = JSON.parse(String(file("mcp/bare/server.json")?.contents));
    expect(bare).toMatchObject({ command: "node", args: ["s.js"], env: { K: "v" } });
  });

  it("reads mcp from mcp-config.json when the manifest has none", () => {
    const dir = join(tmp, "mcpcfg");
    write(join(dir, "plugin.json"), JSON.stringify({ name: "q" }));
    write(
      join(dir, "mcp-config.json"),
      JSON.stringify({ mcpServers: { only: { type: "local", command: "node", args: ["x.js"] } } }),
    );
    const res = importCopilot(dir);
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    const cfg = JSON.parse(
      String(res.files.find((f) => f.relPath === "mcp/only/server.json")?.contents),
    );
    expect(cfg).toMatchObject({ command: "node", args: ["x.js"] });
  });

  it("prefers a verbatim mcp/<leaf>/server.json over the run config", () => {
    const dir = join(tmp, "verbatim");
    write(join(dir, "plugin.json"), JSON.stringify({ name: "v", mcpServers: { ignored: {} } }));
    const verbatim = JSON.stringify({ name: "com.acme/weather", version: "9.9.9" });
    write(join(dir, "mcp/weather/server.json"), verbatim);
    const res = importCopilot(dir);
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.components).toContainEqual({ mcp: "mcp/weather" });
    expect(res.plugin.components).not.toContainEqual({ mcp: "mcp/ignored" });
    const written = JSON.parse(
      String(res.files.find((f) => f.relPath === "mcp/weather/server.json")?.contents),
    );
    expect(written.version).toBe("9.9.9");
  });

  it("imports a bare plugin layout with no manifest", () => {
    const dir = join(tmp, "bare");
    write(join(dir, "skills/x/SKILL.md"), "---\nname: x\ndescription: y\n---\nb");
    const res = importCopilot(dir);
    if (res?.kind !== "plugin") throw new Error("expected a plugin import");
    expect(res.plugin.name).toBe("imported-plugin");
  });

  it("returns null when the directory is not a Copilot plugin", () => {
    const dir = join(tmp, "empty");
    mkdirSync(dir, { recursive: true });
    expect(importCopilot(dir)).toBeNull();
  });
});

describe("importCopilot marketplace", () => {
  it("maps every Copilot source form to a Weft source string", () => {
    const dir = join(tmp, "mkt");
    write(
      join(dir, ".github/plugin/marketplace.json"),
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
    const res = importCopilot(dir, { namespace: "com.test" });
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
