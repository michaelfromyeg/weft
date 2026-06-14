import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import claudeAdapter from "@michaelfromyeg/weft-adapter-claude";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  checkMinVersion,
  dedupePlanned,
  findPlanConflicts,
  gitInfo,
  hasMarketplaceManifest,
  install,
  installMarketplace,
  lint,
  loadMarketplaceDir,
  type PlannedWrite,
  parseSource,
  readLock,
  resolvePluginRef,
  resolveSourceDir,
  uninstall,
  writeLock,
} from "../src/index";

const PLUGIN = fileURLToPath(new URL("../../../fixtures/sample-plugin", import.meta.url));
const MARKETPLACE = fileURLToPath(new URL("../../../fixtures/sample-marketplace", import.meta.url));
const registry = () => new AdapterRegistry().register(claudeAdapter);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "weft-units-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("checkMinVersion", () => {
  it("returns null when no minimum is specified", () => {
    expect(checkMinVersion(undefined)).toBeNull();
  });

  it("returns null when the running Weft satisfies the minimum", () => {
    expect(checkMinVersion("0.0.1")).toBeNull();
  });

  it("returns a message naming the requirement when the minimum is too high", () => {
    const msg = checkMinVersion("9.0.0");
    expect(msg).not.toBeNull();
    expect(msg).toContain("9.0.0");
  });

  it("coerces a loose-but-resolvable minimum rather than rejecting it", () => {
    // semver.coerce("not-a-version") finds no digits -> invalid semver message.
    const msg = checkMinVersion("not-a-version");
    expect(msg).toBe('weft_min_version "not-a-version" is not a valid semver');
  });
});

describe("parseSource", () => {
  it("treats github: prefix and bare owner/repo as github", () => {
    expect(parseSource("github:a/b")).toEqual({ kind: "github", repo: "a/b" });
    expect(parseSource("a/b")).toEqual({ kind: "github", repo: "a/b" });
  });

  it("parses npm: sources with optional version and subdir", () => {
    expect(parseSource("npm:x")).toEqual({ kind: "npm", pkg: "x" });
    expect(parseSource("npm:x@1.2.3")).toEqual({ kind: "npm", pkg: "x", version: "1.2.3" });
    expect(parseSource("npm:@scope/x@1.0.0")).toEqual({
      kind: "npm",
      pkg: "@scope/x",
      version: "1.0.0",
    });
    expect(parseSource("npm:x//skills/a")).toEqual({ kind: "npm", pkg: "x", subdir: "skills/a" });
  });

  it("parses a //subdir (and optional #ref) on github/git refs", () => {
    expect(parseSource("github:a/b//marketplace")).toEqual({
      kind: "github",
      repo: "a/b",
      subdir: "marketplace",
    });
    expect(parseSource("github:a/b//sub#v1")).toEqual({
      kind: "github",
      repo: "a/b",
      ref: "v1",
      subdir: "sub",
    });
    expect(parseSource("a/b//sub")).toEqual({ kind: "github", repo: "a/b", subdir: "sub" });
    expect(parseSource("https://h/x.git//sub")).toEqual({
      kind: "git",
      url: "https://h/x.git",
      subdir: "sub",
    });
  });

  it("parses https and scp-style git urls", () => {
    expect(parseSource("https://github.com/a/b.git")).toEqual({
      kind: "git",
      url: "https://github.com/a/b.git",
    });
    expect(parseSource("git@github.com:a/b.git")).toEqual({
      kind: "git",
      url: "git@github.com:a/b.git",
    });
  });

  it("parses relative and absolute paths as local", () => {
    expect(parseSource("./x")).toEqual({ kind: "local", path: "./x" });
    expect(parseSource("/abs/x")).toEqual({ kind: "local", path: "/abs/x" });
  });
});

describe("resolvePluginRef", () => {
  it("loads a local plugin fixture into a FetchedPlugin", async () => {
    const fb = await resolvePluginRef(PLUGIN, tmp);
    expect(fb.plugin.name).toBe("sample-plugin");
    expect(fb.root).toBe(PLUGIN);
  });
});

describe("resolveSourceDir", () => {
  it("treats an existing local path as local, without parsing it as a remote ref", async () => {
    expect(await resolveSourceDir(PLUGIN, tmp)).toEqual({ dir: PLUGIN, ref: "local", sha: "" });
  });

  it("resolves a relative local dir against fromRoot", async () => {
    const sub = join(tmp, "src-rel");
    cpSync(PLUGIN, sub, { recursive: true });
    expect(await resolveSourceDir("src-rel", tmp)).toEqual({ dir: sub, ref: "local", sha: "" });
  });
});

describe("gitInfo", () => {
  it("resolves to a ref and sha as strings", async () => {
    const info = await gitInfo(PLUGIN);
    expect(typeof info.ref).toBe("string");
    expect(typeof info.sha).toBe("string");
  });
});

describe("lockfile round-trip", () => {
  it("writes then reads back an identical lockfile, and returns null when absent", async () => {
    // Produce a guaranteed-valid Lockfile by running a real install.
    const pluginDir = join(tmp, "lock-plugin");
    cpSync(PLUGIN, pluginDir, { recursive: true });
    const { lockfile } = await install({
      pluginDir,
      scope: "project",
      cwd: join(tmp, "lock-sandbox"),
      registry: registry(),
      now: "2026-01-01T00:00:00.000Z",
    });

    const dir = mkdtempSync(join(tmpdir(), "weft-units-rt-"));
    writeLock(dir, lockfile);
    expect(readLock(dir)).toEqual(lockfile);
    rmSync(dir, { recursive: true, force: true });

    const empty = mkdtempSync(join(tmpdir(), "weft-units-empty-"));
    expect(readLock(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("marketplace loader", () => {
  it("detects a marketplace manifest only when one is present", () => {
    expect(hasMarketplaceManifest(MARKETPLACE)).toBe(true);
    expect(hasMarketplaceManifest(PLUGIN)).toBe(false);
  });

  it("loads the marketplace manifest by name", () => {
    const loaded = loadMarketplaceDir(MARKETPLACE);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.marketplace.name).toBe("acme-tools");
  });

  it("fails on a directory with no marketplace manifest", () => {
    const empty = mkdtempSync(join(tmpdir(), "weft-units-mp-"));
    expect(loadMarketplaceDir(empty).ok).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("installMarketplace", () => {
  it("installs every plugin in a marketplace into the scope, honoring version overrides", async () => {
    // Copy the fixture so the per-plugin locks land in temp, not in fixtures/.
    const mpDir = join(tmp, "mp-install");
    cpSync(MARKETPLACE, mpDir, { recursive: true });
    const cwd = join(tmp, "mp-scope");

    const { marketplace, lockfile, lockPath, installs } = await installMarketplace({
      marketplaceDir: mpDir,
      scope: "project",
      cwd,
      registry: registry(),
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(marketplace.name).toBe("acme-tools");
    expect(installs).toHaveLength(2);
    // One combined lock at the install target records both plugins.
    expect(lockPath).toBe(join(cwd, "weft.lock"));
    expect(lockfile.plugins).toHaveLength(2);
    // Every plugin actually placed artifacts on disk.
    for (const i of installs) {
      expect(i.entry.artifacts.length).toBeGreaterThan(0);
      expect(existsSync(i.entry.artifacts[0].path)).toBe(true);
    }
    // The marketplace.yaml pins weather-tools to 0.2.0; the override must flow through.
    const weather = lockfile.plugins.find((p) => p.id.includes("weather"));
    expect(weather?.version).toBe("0.2.0");
  });
});

describe("target lock: merge and per-plugin uninstall", () => {
  it("accumulates separate installs into one project lock, then uninstalls per plugin", async () => {
    const cwd = join(tmp, "ledger");
    const codeDir = join(tmp, "ledger-code");
    const weatherDir = join(tmp, "ledger-weather");
    cpSync(join(MARKETPLACE, "plugins/code-tools"), codeDir, { recursive: true });
    cpSync(join(MARKETPLACE, "plugins/weather-tools"), weatherDir, { recursive: true });
    const base = {
      scope: "project" as const,
      cwd,
      registry: registry(),
      now: "2026-01-01T00:00:00.000Z",
    };

    await install({ pluginDir: codeDir, ...base });
    const second = await install({ pluginDir: weatherDir, ...base });

    // Both installs live in one project lock; the second didn't clobber the first.
    expect(second.lockfile.plugins).toHaveLength(2);
    expect(readLock(cwd)?.plugins).toHaveLength(2);
    expect(existsSync(join(cwd, ".claude/plugins/code-tools"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/plugins/weather-tools"))).toBe(true);

    // Uninstall one by bare name: its files go, the other plugin stays in the lock.
    const one = uninstall({ dir: cwd, plugin: "code-tools" });
    expect(one.plugins).toHaveLength(1);
    expect(existsSync(join(cwd, ".claude/plugins/code-tools"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/plugins/weather-tools"))).toBe(true);
    expect(readLock(cwd)?.plugins.map((p) => p.id)).toEqual(["com.acme/weather-tools"]);

    // Uninstall the rest: the lock file is removed entirely.
    uninstall({ dir: cwd });
    expect(readLock(cwd)).toBeNull();
    expect(existsSync(join(cwd, ".claude/plugins/weather-tools"))).toBe(false);
  });
});

describe("validatePlugin via lint", () => {
  it("flags a missing server.json as an error", () => {
    const broken = join(tmp, "missing-server");
    cpSync(PLUGIN, broken, { recursive: true });
    rmSync(join(broken, "mcp/weather/server.json"));
    expect(lint(broken).diagnostics.hasErrors).toBe(true);
  });

  it("flags an unparseable server.json as an error", () => {
    const broken = join(tmp, "bad-server-json");
    cpSync(PLUGIN, broken, { recursive: true });
    const serverJson = join(broken, "mcp/weather/server.json");
    writeFileSync(serverJson, "{ this is not valid json");
    const diags = lint(broken).diagnostics;
    expect(diags.hasErrors).toBe(true);
    expect(diags.errors.some((d) => /not valid JSON/.test(d.message))).toBe(true);
  });
});

describe("bare union plan (findPlanConflicts / dedupePlanned)", () => {
  const pw = (abs: string, hash: string): PlannedWrite => ({
    target: "claude",
    relPath: abs,
    abs,
    hash,
    contents: Buffer.from(hash),
  });

  it("flags a path two targets write with different content", () => {
    expect(findPlanConflicts([pw("/o/x", "h1"), pw("/o/x", "h2")])).toEqual(["/o/x"]);
  });

  it("treats identical same-path writes as no conflict", () => {
    expect(findPlanConflicts([pw("/o/x", "h1"), pw("/o/x", "h1"), pw("/o/y", "h2")])).toEqual([]);
  });

  it("dedupes identical same-path writes, first wins", () => {
    const out = dedupePlanned([pw("/o/x", "h1"), pw("/o/x", "h1"), pw("/o/y", "h2")]);
    expect(out.map((p) => p.abs)).toEqual(["/o/x", "/o/y"]);
  });
});
