import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import claudeAdapter from "@michaelfromyeg/weft-adapter-claude";
import codexAdapter from "@michaelfromyeg/weft-adapter-codex";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  build,
  buildMarketplace,
  CompileError,
  install,
  lint,
  resolveAliases,
} from "../src/index";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/sample-plugin", import.meta.url));
const MARKETPLACE = fileURLToPath(new URL("../../../fixtures/sample-marketplace", import.meta.url));
const registry = () => new AdapterRegistry().register(claudeAdapter);

const CLAUDE_AVAILABLE = await execa("claude", ["--version"])
  .then(() => true)
  .catch(() => false);

// The CLI exit-code test shells out via `bun` (the runtime the CLI ships under);
// CI runs on plain node, so skip there rather than fail on a missing binary.
const BUN_AVAILABLE = await execa("bun", ["--version"])
  .then(() => true)
  .catch(() => false);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "weft-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("lint", () => {
  it("reports the sample plugin as valid", () => {
    const r = lint(FIXTURE);
    expect(r.diagnostics.hasErrors).toBe(false);
    expect(r.id).toBe("com.acme/sample-plugin");
    expect(Object.keys(r.aliases).sort()).toEqual(["code-review", "weather"]);
  });

  it("fails closed on a plugin missing a referenced file", () => {
    const broken = join(tmp, "broken");
    cpSync(FIXTURE, broken, { recursive: true });
    rmSync(join(broken, "skills/code-review/SKILL.md"));
    const r = lint(broken);
    expect(r.diagnostics.hasErrors).toBe(true);
  });
});

describe("build", () => {
  it("emits the claude marketplace + plugin + component files", async () => {
    const out = join(tmp, "out");
    const { result, written } = await build({
      pluginDir: FIXTURE,
      outDir: out,
      registry: registry(),
    });
    expect(result.diagnostics.hasErrors).toBe(false);

    const base = join(out, "claude");
    expect(existsSync(join(base, ".claude-plugin/marketplace.json"))).toBe(true);
    expect(existsSync(join(base, "plugins/sample-plugin/.claude-plugin/plugin.json"))).toBe(true);
    expect(existsSync(join(base, "plugins/sample-plugin/skills/code-review/SKILL.md"))).toBe(true);
    expect(written.length).toBe(4);
  });

  it("is deterministic: identical hashes across two builds", async () => {
    const a = await build({ pluginDir: FIXTURE, outDir: join(tmp, "a"), registry: registry() });
    const b = await build({ pluginDir: FIXTURE, outDir: join(tmp, "b"), registry: registry() });
    const norm = (w: typeof a.written) => w.map((x) => `${x.relPath}:${x.hash}`).sort();
    expect(norm(a.written)).toEqual(norm(b.written));
  });

  it.skipIf(!CLAUDE_AVAILABLE)("passes `claude plugin validate --strict`", async () => {
    const out = join(tmp, "validated");
    await build({ pluginDir: FIXTURE, outDir: out, registry: registry() });
    const res = await execa("claude", ["plugin", "validate", join(out, "claude"), "--strict"], {
      reject: false,
    });
    expect(res.exitCode).toBe(0);
  });
});

describe("multi-target --bare (union)", () => {
  it("unions multiple targets into one --out: both catalogs at root, shared files deduped", async () => {
    const out = join(tmp, "union");
    const reg = new AdapterRegistry().register(claudeAdapter).register(codexAdapter);
    const { written } = await build({ pluginDir: FIXTURE, outDir: out, registry: reg, bare: true });
    // Each harness's native catalog lands at its own root path -- no <target>/ subdir.
    expect(existsSync(join(out, ".claude-plugin/marketplace.json"))).toBe(true);
    expect(existsSync(join(out, ".agents/plugins/marketplace.json"))).toBe(true);
    expect(existsSync(join(out, "claude"))).toBe(false);
    // A SKILL.md shared by both target builds is written exactly once (deduped).
    const skill = "plugins/sample-plugin/skills/code-review/SKILL.md";
    expect(written.filter((w) => w.relPath === skill)).toHaveLength(1);
    expect(existsSync(join(out, skill))).toBe(true);
  });
});

describe("build --check (drift guard)", () => {
  const SKILL_REL = "plugins/sample-plugin/skills/code-review/SKILL.md";
  const CATALOG_REL = ".claude-plugin/marketplace.json";

  it("reports a clean tree right after a build", async () => {
    const out = join(tmp, "chk-clean");
    const w = await build({ pluginDir: FIXTURE, outDir: out, registry: registry() });
    const { written, drift } = await build({
      pluginDir: FIXTURE,
      outDir: out,
      registry: registry(),
      check: true,
    });
    expect(drift?.clean).toBe(true);
    expect(drift?.missing).toEqual([]);
    expect(drift?.stale).toEqual([]);
    // Check reports the same artifact set a write would produce, and nothing extra.
    expect(drift?.checked).toBe(w.written.length);
    expect(written.length).toBe(w.written.length);
  });

  it("flags a hand-edited manifest as stale", async () => {
    const out = join(tmp, "chk-stale");
    await build({ pluginDir: FIXTURE, outDir: out, registry: registry() });
    writeFileSync(join(out, "claude", CATALOG_REL), "{ not the compiled catalog }");
    const { drift } = await build({
      pluginDir: FIXTURE,
      outDir: out,
      registry: registry(),
      check: true,
    });
    expect(drift?.clean).toBe(false);
    expect(drift?.stale).toContain(CATALOG_REL);
    expect(drift?.missing).toEqual([]);
  });

  it("flags a deleted artifact as missing", async () => {
    const out = join(tmp, "chk-missing");
    await build({ pluginDir: FIXTURE, outDir: out, registry: registry() });
    rmSync(join(out, "claude", SKILL_REL));
    const { drift } = await build({
      pluginDir: FIXTURE,
      outDir: out,
      registry: registry(),
      check: true,
    });
    expect(drift?.clean).toBe(false);
    expect(drift?.missing).toContain(SKILL_REL);
  });

  it("never writes: an empty out dir is all-missing and is not created", async () => {
    const out = join(tmp, "chk-nowrite");
    const { drift } = await build({
      pluginDir: FIXTURE,
      outDir: out,
      registry: registry(),
      check: true,
    });
    expect(drift?.clean).toBe(false);
    expect(drift?.missing.length).toBe(drift?.checked);
    expect(drift?.stale).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("checks a bare marketplace at the out root and catches drift", async () => {
    const out = join(tmp, "chk-bare");
    await buildMarketplace({
      marketplaceDir: MARKETPLACE,
      outDir: out,
      registry: registry(),
      targets: ["claude"],
      bare: true,
    });
    const clean = await buildMarketplace({
      marketplaceDir: MARKETPLACE,
      outDir: out,
      registry: registry(),
      targets: ["claude"],
      bare: true,
      check: true,
    });
    expect(clean.drift?.clean).toBe(true);

    writeFileSync(join(out, CATALOG_REL), "{ drifted }");
    const drifted = await buildMarketplace({
      marketplaceDir: MARKETPLACE,
      outDir: out,
      registry: registry(),
      targets: ["claude"],
      bare: true,
      check: true,
    });
    expect(drifted.drift?.clean).toBe(false);
    expect(drifted.drift?.stale).toContain(CATALOG_REL);
  });

  it.skipIf(!BUN_AVAILABLE)("CLI exits 1 on drift and 0 when up to date", async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const cli = ["packages/cli/src/index.ts", "build", FIXTURE];
    const out = join(tmp, "chk-cli");

    const empty = await execa("bun", [...cli, "--out", out, "--check"], {
      cwd: repoRoot,
      reject: false,
    });
    expect(empty.exitCode).toBe(1);

    await execa("bun", [...cli, "--out", out], { cwd: repoRoot });
    const fresh = await execa("bun", [...cli, "--out", out, "--check"], {
      cwd: repoRoot,
      reject: false,
    });
    expect(fresh.exitCode).toBe(0);
  });
});

describe("install", () => {
  it("places the plugin tree into the scope and writes a lockfile", async () => {
    const pluginDir = join(tmp, "plugin");
    const sandbox = join(tmp, "sandbox");
    cpSync(FIXTURE, pluginDir, { recursive: true });

    const r = await install({
      pluginDir,
      scope: "project",
      cwd: sandbox,
      registry: registry(),
      now: "2026-01-01T00:00:00.000Z",
    });

    // The lock lives at the install target (sandbox), not the source plugin dir.
    expect(existsSync(join(pluginDir, "weft.lock"))).toBe(false);
    expect(existsSync(join(sandbox, "weft.lock"))).toBe(true);
    expect(r.lockfile.artifacts).toHaveLength(3);
    expect(r.lockfile.plugins).toHaveLength(1);
    expect(r.lockfile.adapters.claude?.targetSchema).toBe("claude-code-plugin/2.1");
    expect(
      existsSync(join(sandbox, ".claude/plugins/sample-plugin/.claude-plugin/plugin.json")),
    ).toBe(true);

    // The on-disk lockfile round-trips through the schema.
    const lock = JSON.parse(readFileSync(join(sandbox, "weft.lock"), "utf8"));
    expect(lock.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(lock.artifacts.every((a: { enabled: boolean }) => a.enabled === true)).toBe(true);
  });
});

describe("piecemeal install (spec §9.2)", () => {
  it("installs only the requested component, with no others in the manifest", async () => {
    const pluginDir = join(tmp, "piece-plugin");
    const sandbox = join(tmp, "piece-sandbox");
    cpSync(FIXTURE, pluginDir, { recursive: true });

    const r = await install({
      pluginDir,
      scope: "project",
      cwd: sandbox,
      registry: registry(),
      only: ["code-review"],
      now: "2026-01-01T00:00:00.000Z",
    });

    // Just the skill + the plugin manifest -- the MCP server is excluded.
    expect(r.lockfile.artifacts.map((a) => a.component).sort()).toEqual([
      "com.acme/sample-plugin",
      "com.acme/sample-plugin:code-review",
    ]);
    expect(
      existsSync(join(sandbox, ".claude/plugins/sample-plugin/skills/code-review/SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(sandbox, ".claude/plugins/sample-plugin/mcp/weather/server.json"))).toBe(
      false,
    );

    const manifest = JSON.parse(
      readFileSync(
        join(sandbox, ".claude/plugins/sample-plugin/.claude-plugin/plugin.json"),
        "utf8",
      ),
    );
    expect(manifest.mcpServers).toBeUndefined();
  });

  it("errors when --only names a component that does not exist", async () => {
    const pluginDir = join(tmp, "piece-bad");
    cpSync(FIXTURE, pluginDir, { recursive: true });
    const err = await install({
      pluginDir,
      scope: "project",
      cwd: join(tmp, "x"),
      registry: registry(),
      only: ["nope"],
    })
      .then(() => null)
      .catch((e) => e as CompileError);
    expect(err).toBeInstanceOf(CompileError);
    expect(err?.diagnostics.some((d) => /not found/.test(d.message))).toBe(true);
  });
});

describe("marketplace build (spec §6.2)", () => {
  it("compiles many plugins into one catalog", async () => {
    const out = join(tmp, "mp");
    const { marketplace, plugins, written } = await buildMarketplace({
      marketplaceDir: MARKETPLACE,
      outDir: out,
      registry: registry(),
    });
    expect(marketplace.name).toBe("acme-tools");
    expect(plugins).toHaveLength(2);

    const catalog = JSON.parse(
      readFileSync(join(out, "claude/.claude-plugin/marketplace.json"), "utf8"),
    );
    expect(catalog.plugins.map((p: { name: string }) => p.name).sort()).toEqual([
      "code-tools",
      "weather-tools",
    ]);
    // Both plugin trees are placed.
    expect(existsSync(join(out, "claude/plugins/code-tools/skills/lint/SKILL.md"))).toBe(true);
    expect(existsSync(join(out, "claude/plugins/weather-tools/mcp/weather/server.json"))).toBe(
      true,
    );
    expect(written.length).toBeGreaterThanOrEqual(5);
  });

  it("bare mode writes the catalog at outDir root (a Claude-consumable repo)", async () => {
    const out = join(tmp, "mp-bare");
    await buildMarketplace({
      marketplaceDir: MARKETPLACE,
      outDir: out,
      registry: registry(),
      targets: ["claude"],
      bare: true,
    });
    // No <target>/ nesting: .claude-plugin/marketplace.json is at the root.
    expect(existsSync(join(out, ".claude-plugin/marketplace.json"))).toBe(true);
    expect(existsSync(join(out, "claude/.claude-plugin/marketplace.json"))).toBe(false);
    expect(existsSync(join(out, "plugins/code-tools/skills/lint/SKILL.md"))).toBe(true);
  });

  it("propagates an entry version override into the compiled plugin.json", async () => {
    const out = join(tmp, "mp-ver");
    await buildMarketplace({ marketplaceDir: MARKETPLACE, outDir: out, registry: registry() });
    const manifest = JSON.parse(
      readFileSync(join(out, "claude/plugins/weather-tools/.claude-plugin/plugin.json"), "utf8"),
    );
    // marketplace.yaml overrides weather-tools to 0.2.0; plugin.json must agree.
    expect(manifest.version).toBe("0.2.0");
  });

  it.skipIf(!CLAUDE_AVAILABLE)(
    "produces a marketplace that passes `claude plugin validate --strict`",
    async () => {
      const out = join(tmp, "mp-validate");
      await buildMarketplace({ marketplaceDir: MARKETPLACE, outDir: out, registry: registry() });
      const res = await execa("claude", ["plugin", "validate", join(out, "claude"), "--strict"], {
        reject: false,
      });
      expect(res.exitCode).toBe(0);
    },
  );
});

describe("namespacing (spec §9.4)", () => {
  it("gives a bare alias when a leaf is unique", () => {
    const { aliases, collisions } = resolveAliases([
      { id: "com.a/x:deploy", leaf: "deploy" },
      { id: "com.a/x:test", leaf: "test" },
    ]);
    expect(collisions).toHaveLength(0);
    expect(aliases.deploy).toBe("com.a/x:deploy");
  });

  it("surfaces a collision instead of last-wins", () => {
    const { collisions } = resolveAliases([
      { id: "com.a/x:deploy", leaf: "deploy" },
      { id: "com.b/y:deploy", leaf: "deploy" },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].ids).toEqual(["com.a/x:deploy", "com.b/y:deploy"]);
  });
});
