import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  build,
  buildMarketplace,
  CompileError,
  type DriftReport,
  generateSigningKeys,
  type HarnessCheck,
  hasMarketplaceManifest,
  importNativePlugin,
  install,
  installMarketplace,
  lint,
  lockDirForScope,
  type MarketplaceActionResult,
  marketplaceAdd,
  marketplaceInstall,
  marketplaceRemove,
  readLock,
  resolveSourceDir,
  signLock,
  uninstall,
  update,
  verifyArtifacts,
  WEFT_VERSION,
} from "@michaelfromyeg/weft-core";
import { compareVersions, discoverEvals, runEval } from "@michaelfromyeg/weft-eval";
import {
  federate,
  fetchMcpRegistry,
  indexFromPluginDirs,
  publishCheck,
  serializeIndex,
} from "@michaelfromyeg/weft-index";
import type { Scope, Target } from "@michaelfromyeg/weft-schema";
import { defineCommand, runMain } from "citty";
import { renderCliReference } from "./cli-docs";
import { log } from "./logger";
import { allDrivers, buildRegistry, parseList, parseTargets } from "./registry";
import { printComparison, printDiagnostics, printEvalReport, printTrustSummary } from "./report";
import { scaffoldPlugin } from "./scaffold";

/** Filter requested targets to harnesses actually present on this machine. */
async function detectPresent(
  requested: Target[],
): Promise<{ present: Target[]; missing: Target[] }> {
  const drivers = allDrivers();
  const present: Target[] = [];
  const missing: Target[] = [];
  for (const t of requested) {
    if (await drivers[t]?.available()) present.push(t);
    else missing.push(t);
  }
  return { present, missing };
}

function countByTarget(written: { target: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of written) counts.set(w.target, (counts.get(w.target) ?? 0) + 1);
  return counts;
}

/** Print a `--check` drift report and exit 1 if `--out` is stale (the CI guard). */
function reportDrift(drift: DriftReport, out: string): void {
  log.data({ check: true, out, ...drift });
  if (drift.clean) {
    log.info(`${out} is up to date (${drift.checked} files)`);
    return;
  }
  for (const p of drift.missing) log.error(`  + missing ${p}`);
  for (const p of drift.stale) log.error(`  ~ stale   ${p}`);
  log.error(
    `\n${out} is out of date with source (${drift.missing.length} missing, ${drift.stale.length} stale); rerun the same build without --check and commit the result`,
  );
  process.exit(1);
}

/** Parse `codex@0.130,claude@2.1` into {codex:"0.130", claude:"2.1"} for --harness. */
function parseHarnessVersions(spec: string | undefined): Record<string, string> | undefined {
  if (!spec) return undefined;
  const out: Record<string, string> = {};
  for (const pair of spec.split(",").map((s) => s.trim())) {
    const at = pair.lastIndexOf("@");
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Warn for any target whose installed/declared harness version is outside the verified range. */
function reportHarness(checks: HarnessCheck[]): void {
  for (const c of checks) {
    if (c.satisfied !== false) continue;
    log.warn(
      `! ${c.target}: ${c.name} ${c.version} is outside the verified range "${c.range}" ` +
        `(${c.source}). The emitted format may be stale -- check for a weft update, or re-verify the adapter.`,
    );
  }
}

function fail(err: unknown): never {
  if (err instanceof CompileError) {
    log.error(`\n${err.message}:`);
    printDiagnostics(err.diagnostics);
  } else {
    log.error(`\n${(err as Error).message}`);
  }
  process.exit(1);
}

/**
 * Resolve the "before" side of a vibes comparison. An existing path is used as the
 * older plugin dir directly; otherwise `ref` is a git ref, checked out into a
 * throwaway worktree (the plugin sits at the same repo-relative path there).
 */
function resolveCompareDir(ref: string, currentDir: string): { dir: string; cleanup: () => void } {
  if (existsSync(ref)) return { dir: ref, cleanup: () => undefined };
  const git = (args: string[]) =>
    execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] });
  const repoRoot = git(["-C", currentDir, "rev-parse", "--show-toplevel"]).toString().trim();
  const rel = relative(repoRoot, resolve(currentDir));
  const wt = mkdtempSync(join(tmpdir(), "weft-compare-wt-"));
  git(["-C", repoRoot, "worktree", "add", "--detach", wt, ref]);
  return {
    dir: join(wt, rel),
    cleanup: () => {
      try {
        git(["-C", repoRoot, "worktree", "remove", "--force", wt]);
      } catch {
        /* best effort */
      }
      rmSync(wt, { recursive: true, force: true });
    },
  };
}

const initCmd = defineCommand({
  meta: { name: "init", description: "Scaffold a new plugin (weft.yaml + a sample skill)" },
  args: {
    dir: { type: "positional", required: false, default: ".", description: "Target directory" },
    name: { type: "string", description: "Plugin name (kebab-case)" },
    namespace: { type: "string", description: "Reverse-DNS namespace, e.g. com.acme" },
  },
  run({ args }) {
    const created = scaffoldPlugin({
      dir: args.dir,
      name: args.name,
      namespace: args.namespace,
    });
    log.info(`Scaffolded plugin "${created.name}" in ${created.dir}`);
    for (const f of created.files) log.info(`  + ${f}`);
    log.info(`\nNext: weft validate ${args.dir} && weft build ${args.dir}`);
  },
});

const validateCmd = defineCommand({
  meta: { name: "validate", description: "Statically validate a plugin (the valid badge)" },
  args: {
    dir: { type: "positional", required: false, default: ".", description: "Plugin directory" },
  },
  run({ args }) {
    try {
      const result = lint(args.dir);
      const { items, hasErrors } = result.diagnostics;
      if (items.length > 0) printDiagnostics(items);
      if (hasErrors) {
        log.error(`\n${result.id}: invalid`);
        process.exit(1);
      }
      log.data({ id: result.id, valid: true, components: result.plugin.components.length });
      log.info(`${result.id}: valid (${result.plugin.components.length} components)`);
    } catch (err) {
      fail(err);
    }
  },
});

const buildCmd = defineCommand({
  meta: {
    name: "build",
    description: "Compile a plugin (or a marketplace of plugins) to harness manifests",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      default: ".",
      description: "Local dir, or a remote ref (github:/npm:/owner/repo, optional //subdir)",
    },
    out: { type: "string", default: ".weft-out", description: "Output directory" },
    target: { type: "string", description: "Comma-separated targets (default: all registered)" },
    bare: {
      type: "boolean",
      description:
        "Write straight to --out without the <target>/ subdir, so a repo root becomes a native marketplace. Accepts multiple --target (unioned into one tree); errors if two targets write different content to the same path.",
    },
    check: {
      type: "boolean",
      description:
        "Verify --out is already up to date with a fresh compile instead of writing (exit 1 on drift); the CI guard for a committed `--out . --bare` marketplace. Does not detect orphaned files.",
    },
    harness: {
      type: "string",
      description:
        "Declare installed harness version(s) to check the emitted format against, e.g. `codex@0.130` (comma-separated). Skips auto-detection for those targets.",
    },
    "harness-check": {
      type: "boolean",
      default: true,
      description:
        "Detect the installed harness version per target and warn when the emitted format is outside the adapter's verified range (axis 4). Use --no-harness-check for hermetic builds.",
    },
  },
  async run({ args }) {
    try {
      const registry = buildRegistry();
      const targets = parseTargets(args.target);
      const check = Boolean(args.check);
      const harnessVersions = parseHarnessVersions(args.harness);
      const harnessCheck = args["harness-check"] !== false;
      // A remote ref (github:/git/owner-repo, optionally //subdir) clones into the
      // cache; a local path is used as-is.
      const { dir } = await resolveSourceDir(args.dir, process.cwd());

      // A marketplace.yaml packages many plugins into one catalog.
      if (hasMarketplaceManifest(dir)) {
        const { marketplace, plugins, written, drift, harnessChecks } = await buildMarketplace({
          marketplaceDir: dir,
          outDir: args.out,
          registry,
          targets,
          bare: Boolean(args.bare),
          check,
          harnessVersions,
          harnessCheck,
        });
        reportHarness(harnessChecks);
        if (drift) {
          reportDrift(drift, args.out);
          return;
        }
        log.data({
          marketplace: marketplace.name,
          plugins: plugins.length,
          out: args.out,
          files: Object.fromEntries(countByTarget(written)),
        });
        log.info(
          `Built marketplace ${marketplace.name} (${plugins.length} plugins) -> ${args.out}/`,
        );
        for (const [t, n] of countByTarget(written)) log.info(`  ${t}: ${n} files`);
        return;
      }

      const { result, written, drift, harnessChecks } = await build({
        pluginDir: dir,
        outDir: args.out,
        registry,
        targets,
        bare: Boolean(args.bare),
        check,
        harnessVersions,
        harnessCheck,
      });
      if (result.diagnostics.items.length > 0) printDiagnostics(result.diagnostics.items);
      reportHarness(harnessChecks);
      if (drift) {
        reportDrift(drift, args.out);
        return;
      }
      log.data({ id: result.id, out: args.out, files: Object.fromEntries(countByTarget(written)) });
      log.info(`Built ${result.id} -> ${args.out}/`);
      for (const [t, n] of countByTarget(written)) {
        log.info(`  ${t}: ${n} files (catalog at ${args.out}/${t})`);
      }
    } catch (err) {
      fail(err);
    }
  },
});

const installCmd = defineCommand({
  meta: {
    name: "install",
    description: "Compile + place a plugin (or a whole marketplace) into harness scopes",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      default: ".",
      description: "Local dir, or a remote ref (github:/npm:/owner/repo, optional //subdir)",
    },
    scope: { type: "string", default: "project", description: "user | project" },
    target: { type: "string", description: "Comma-separated targets (default: all registered)" },
    only: {
      type: "string",
      description: "Comma-separated component names to install piecemeal (e.g. one skill)",
    },
    all: {
      type: "boolean",
      description: "Install to requested targets even if the harness is not detected",
    },
    managed: {
      type: "string",
      description: "Managed mode: only allow these namespaces (comma-separated allowlist)",
    },
    cwd: { type: "string", description: "Project root for project-scope placement (default: cwd)" },
  },
  async run({ args }) {
    try {
      const registry = buildRegistry();
      const scope = (args.scope === "user" ? "user" : "project") as Scope;
      const requested = parseTargets(args.target) ?? registry.targets;
      const allow = parseList(args.managed);

      // Skip targets whose harness isn't on this machine, and say so (spec §9.2).
      let targets = requested;
      if (!args.all) {
        const { present, missing } = await detectPresent(requested);
        for (const t of missing) log.info(`  skipped ${t}: harness not detected`);
        if (present.length === 0) {
          log.error("No requested harness is installed. Use --all to place anyway.");
          process.exit(1);
        }
        targets = present;
      }

      // A remote ref (github:/git/npm/owner-repo, optionally //subdir) is fetched
      // into the cache; a local path is used as-is.
      const { dir } = await resolveSourceDir(args.dir, process.cwd());

      // A marketplace.yaml installs all of its plugins across the targets at once.
      if (hasMarketplaceManifest(dir)) {
        const mp = await installMarketplace({
          marketplaceDir: dir,
          scope,
          cwd: args.cwd ?? process.cwd(),
          registry,
          targets,
          ...(allow ? { managed: { allowNamespaces: allow } } : {}),
        });
        log.data({
          marketplace: mp.marketplace.name,
          plugins: mp.installs.map((i) => i.result.id),
          scope,
          lockfile: mp.lockPath,
        });
        log.info(
          `Installed marketplace ${mp.marketplace.name} (${mp.installs.length} plugins, ${scope})`,
        );
        for (const i of mp.installs) {
          log.info(
            `  ${i.result.id}@${i.result.fb.plugin.version}: ${i.entry.artifacts.length} artifacts`,
          );
        }
        log.info(`  lockfile: ${mp.lockPath}`);
        return;
      }

      const result = await install({
        pluginDir: dir,
        scope,
        cwd: args.cwd ?? process.cwd(),
        registry,
        targets,
        only: parseList(args.only),
        ...(allow ? { managed: { allowNamespaces: allow } } : {}),
      });
      printTrustSummary(result.result);
      log.data({
        id: result.result.id,
        version: result.result.fb.plugin.version,
        scope,
        artifacts: result.entry.artifacts.length,
        lockfile: result.lockPath,
      });
      log.info(`Installed ${result.result.id}@${result.result.fb.plugin.version} (${scope})`);
      log.info(`  ${result.entry.artifacts.length} artifacts placed`);
      if (result.secrets.resolved.length > 0) {
        const missing = result.secrets.resolved.filter((r) => r.source === "missing");
        log.info(
          `  config: ${result.secrets.resolved.length} declared` +
            (result.secrets.path ? ` -> ${result.secrets.path} (gitignored)` : "") +
            (missing.length > 0 ? `; missing: ${missing.map((m) => m.env).join(", ")}` : ""),
        );
      }
      log.info(`  lockfile: ${result.lockPath}`);
    } catch (err) {
      fail(err);
    }
  },
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Re-resolve refs, recompile, and re-place only artifacts whose hash changed",
  },
  args: {
    dir: { type: "positional", required: false, default: ".", description: "Plugin directory" },
    scope: { type: "string", default: "project", description: "user | project" },
    target: { type: "string", description: "Comma-separated targets (default: all registered)" },
    cwd: { type: "string", description: "Project root for project-scope placement (default: cwd)" },
  },
  async run({ args }) {
    try {
      const scope = (args.scope === "user" ? "user" : "project") as Scope;
      const cwd = args.cwd ?? process.cwd();
      // Default to the targets already in the target lockfile, so update matches
      // what install placed (not every registered adapter).
      const lock = readLock(lockDirForScope(scope, cwd));
      const lockedTargets = lock
        ? ([...new Set(lock.artifacts.map((a) => a.target))] as Target[])
        : undefined;
      const result = await update({
        pluginDir: args.dir,
        scope,
        cwd,
        registry: buildRegistry(),
        targets: parseTargets(args.target) ?? lockedTargets,
      });
      log.data({ id: result.id, changed: result.changed });
      log.info(`Updated ${result.id}: ${result.changed.length} artifact(s) changed`);
      for (const p of result.changed) log.info(`  ~ ${p}`);
    } catch (err) {
      fail(err);
    }
  },
});

const evalCmd = defineCommand({
  meta: {
    name: "eval",
    description: "Run a component's evals against the real harnesses (reports UNTESTED honestly)",
  },
  args: {
    dir: { type: "positional", required: false, default: ".", description: "Plugin directory" },
    component: { type: "string", description: "Only eval this component leaf name" },
    harness: { type: "string", description: "Restrict to these harnesses (comma-separated)" },
    compare: {
      type: "string",
      description:
        "Vibes A/B: run each case against this git ref (or dir) and the working tree, side by side",
    },
  },
  async run({ args }) {
    try {
      const registry = buildRegistry();
      const drivers = allDrivers();
      const discovered = discoverEvals(args.dir).filter(
        (d) => !args.component || d.componentLeaf === args.component,
      );
      if (discovered.length === 0) {
        log.info("No evals found (a component adds them with an `evals:` file).");
        return;
      }
      const onlyHarness = parseTargets(args.harness);
      const filterHarnesses = (ef: (typeof discovered)[number]["evalFile"]) =>
        onlyHarness
          ? { ...ef, harnesses: ef.harnesses.filter((h) => onlyHarness.includes(h)) }
          : ef;

      // Vibes A/B: render each case's before (a git ref / dir) vs after (working tree).
      if (args.compare) {
        const { dir: beforeDir, cleanup } = resolveCompareDir(args.compare, args.dir);
        try {
          for (const d of discovered) {
            const reports = await compareVersions({
              evalFile: filterHarnesses(d.evalFile),
              componentLeaf: d.componentLeaf,
              beforeDir,
              afterDir: args.dir,
              registry,
              drivers,
            });
            printComparison(d.componentLeaf, args.compare, reports);
          }
        } finally {
          cleanup();
        }
        return;
      }

      let anyFail = false;
      for (const d of discovered) {
        const report = await runEval({
          evalFile: filterHarnesses(d.evalFile),
          pluginDir: args.dir,
          componentLeaf: d.componentLeaf,
          registry,
          drivers,
        });
        printEvalReport(report);
        if (report.harnesses.some((h) => h.status === "tested" && !h.pass)) anyFail = true;
      }
      if (anyFail) process.exit(1);
    } catch (err) {
      fail(err);
    }
  },
});

const publishCmd = defineCommand({
  meta: {
    name: "publish",
    description: "Run the deterministic publish gate (static valid + trace/output evals)",
  },
  args: {
    dir: { type: "positional", required: false, default: ".", description: "Plugin directory" },
    snapshot: {
      type: "boolean",
      description: "Snapshot eval scores into evals/.baselines/ for the next release",
    },
  },
  async run({ args }) {
    try {
      const res = await publishCheck(args.dir, {
        registry: buildRegistry(),
        drivers: allDrivers(),
        snapshot: Boolean(args.snapshot),
      });
      log.data({
        id: res.id,
        version: res.version,
        ok: res.ok,
        valid: res.validPassed,
        scanClean: res.scan.clean,
        badges: res.badges,
        harnessCoverage: res.harnessCoverage,
      });
      log.info(`Publish check: ${res.id}@${res.version}`);
      if (res.diagnostics.length > 0) printDiagnostics(res.diagnostics);
      log.info(`  valid: ${res.validPassed ? "yes" : "NO"}`);
      log.info(`  scan: ${res.scan.clean ? "clean" : `${res.scan.findings.length} finding(s)`}`);
      log.info(`  badges: ${res.badges.join(", ") || "none"}`);
      log.info(`  harness coverage: ${res.harnessCoverage.join(", ") || "none"}`);
      for (const r of res.evalReports) printEvalReport(r);
      if (!res.ok) {
        log.error("\nPublish BLOCKED: the deterministic tier failed.");
        process.exit(1);
      }
      log.info("\nPublish gate passed.");
    } catch (err) {
      fail(err);
    }
  },
});

const signCmd = defineCommand({
  meta: {
    name: "sign",
    description:
      "Sign weft.lock's artifact set (ed25519) -> weft.sig + weft.pub (the signed badge)",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      default: ".",
      description: "Plugin dir with weft.lock",
    },
  },
  run({ args }) {
    try {
      const lock = readLock(args.dir);
      if (!lock) {
        log.error("no weft.lock found (run `weft install` first)");
        process.exit(1);
      }
      const weftDir = join(args.dir, ".weft");
      mkdirSync(weftDir, { recursive: true });
      writeFileSync(join(weftDir, ".gitignore"), "*\n");
      const keyPath = join(weftDir, "signing.key");

      let privateKey: ReturnType<typeof createPrivateKey>;
      if (existsSync(keyPath)) {
        privateKey = createPrivateKey(readFileSync(keyPath));
      } else {
        const keys = generateSigningKeys();
        privateKey = keys.privateKey;
        writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
        writeFileSync(
          join(args.dir, "weft.pub"),
          keys.publicKey.export({ type: "spki", format: "pem" }),
        );
      }
      writeFileSync(join(args.dir, "weft.sig"), `${signLock(lock, privateKey)}\n`);
      log.info(
        `Signed ${lock.artifacts.length} artifacts -> weft.sig (key kept in .weft/, public key in weft.pub)`,
      );
    } catch (err) {
      fail(err);
    }
  },
});

const verifyCmd = defineCommand({
  meta: {
    name: "verify",
    description: "Verify weft.sig against weft.lock and the on-disk artifacts",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      default: ".",
      description: "Plugin dir with weft.lock",
    },
  },
  run({ args }) {
    try {
      const lock = readLock(args.dir);
      if (!lock) {
        log.error("no weft.lock found");
        process.exit(1);
      }
      const sig = readFileSync(join(args.dir, "weft.sig"), "utf8").trim();
      const publicKey = createPublicKey(readFileSync(join(args.dir, "weft.pub")));
      const res = verifyArtifacts(lock, publicKey, sig);
      log.data({ signatureValid: res.signatureValid, tampered: res.tampered });
      log.info(`signature: ${res.signatureValid ? "valid" : "INVALID"}`);
      log.info(`tampered artifacts: ${res.tampered.length}`);
      for (const p of res.tampered) log.info(`  ! ${p}`);
      if (!res.signatureValid || res.tampered.length > 0) process.exit(1);
      log.info("signed badge verified.");
    } catch (err) {
      fail(err);
    }
  },
});

const indexCmd = defineCommand({
  meta: {
    name: "index",
    description: "Build a metadata index from plugin dirs (optionally federating the MCP Registry)",
  },
  args: {
    dir: { type: "positional", required: false, default: ".", description: "Plugin directories" },
    out: { type: "string", default: "index.json", description: "Output index file" },
    federate: { type: "boolean", description: "Ingest the MCP Registry (GET /v0.1/servers)" },
  },
  async run({ args }) {
    try {
      // citty puts every positional in `_`; default to the current dir when none.
      const positionals = (args._ as string[] | undefined) ?? [];
      const dirs = positionals.length > 0 ? positionals : ["."];
      let index = await indexFromPluginDirs(dirs);
      if (args.federate) {
        const servers = await fetchMcpRegistry({ limit: 30 });
        index = federate(index, servers, new Date().toISOString());
      }
      writeFileSync(args.out, serializeIndex(index));
      const fed = args.federate ? `, federated ${index.federated?.length ?? 0} source(s)` : "";
      log.data({
        plugins: index.plugins.length,
        federated: index.federated?.length ?? 0,
        out: args.out,
      });
      log.info(`Wrote index (${index.plugins.length} plugins${fed}) -> ${args.out}`);
    } catch (err) {
      fail(err);
    }
  },
});

const importCmd = defineCommand({
  meta: {
    name: "import",
    description: "Reverse-compile an existing native plugin/marketplace into a Weft plugin",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      default: ".",
      description: "Dir with an existing native plugin or marketplace",
    },
    from: { type: "string", default: "claude", description: "Source harness format" },
    out: { type: "string", default: "imported", description: "Output directory" },
    namespace: {
      type: "string",
      description: "Reverse-DNS namespace to assign (default com.imported)",
    },
  },
  run({ args }) {
    try {
      const adapter = buildRegistry().get(args.from as Target);
      if (!adapter) {
        log.error(`unknown source harness "${args.from}"`);
        process.exit(1);
      }
      const res = importNativePlugin({
        dir: args.dir,
        adapter,
        outDir: args.out,
        ...(args.namespace ? { namespace: args.namespace } : {}),
      });
      log.data({
        kind: res.kind,
        name: res.name,
        manifest: res.manifestPath,
        out: res.outDir,
        ...(res.kind === "plugin" ? { files: res.fileCount } : {}),
      });
      log.info(`Imported ${res.kind} "${res.name}" -> ${res.manifestPath}`);
      if (res.kind === "plugin") log.info(`  ${res.fileCount} component file(s)`);
      log.info(`  next: weft build ${res.outDir}`);
    } catch (err) {
      fail(err);
    }
  },
});

const uninstallCmd = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove what install placed into this project (read from its weft.lock)",
  },
  args: {
    dir: {
      type: "positional",
      required: false,
      default: ".",
      description: "Install target holding weft.lock (default: derived from --scope)",
    },
    scope: { type: "string", default: "project", description: "user | project" },
    plugin: {
      type: "string",
      description: "Remove only this plugin (id or bare name); default removes all",
    },
  },
  run({ args }) {
    try {
      const scope = (args.scope === "user" ? "user" : "project") as Scope;
      // An explicit dir wins; otherwise read the lock from the scope's target
      // (the project cwd for project scope, ~/.weft for user scope).
      const dir = args.dir === "." ? lockDirForScope(scope, process.cwd()) : args.dir;
      const res = uninstall({ dir, ...(args.plugin ? { plugin: args.plugin } : {}) });
      log.data({ removed: res.removed, plugins: res.plugins });
      log.info(`Uninstalled ${res.plugins.length} plugin(s), ${res.removed.length} artifact(s)`);
    } catch (err) {
      fail(err);
    }
  },
});

const docsCmd = defineCommand({
  meta: {
    name: "docs",
    description: "Print the full CLI reference (a CLI map), generated from the command tree",
  },
  args: {
    out: {
      type: "string",
      description: "Write the Markdown reference to this file instead of stdout",
    },
  },
  async run({ args }) {
    const md = await renderCliReference(main);
    if (args.out) {
      writeFileSync(args.out, md);
      log.info(`Wrote CLI reference to ${args.out}`);
    } else {
      process.stdout.write(md);
    }
  },
});

/** Adapters to drive, filtered by an optional comma-separated --target. */
function adaptersFor(targetArg: string | undefined) {
  const registry = buildRegistry();
  const targets = parseTargets(targetArg) ?? registry.targets;
  return targets.map((t) => registry.get(t)).filter((a) => a !== undefined);
}

/** Print a per-harness marketplace action report; exit 1 if any harness command failed. */
function reportMarketplace(results: MarketplaceActionResult[]): void {
  log.data({ results });
  if (results.length === 0) {
    log.warn("No registered harness exposes a marketplace.");
    return;
  }
  let failed = 0;
  for (const r of results) {
    if (r.status === "ok") log.info(`  ok   ${r.name}: ${r.command}`);
    else if (r.status === "manual") log.info(`  app  ${r.name}: ${r.message}`);
    else if (r.status === "not-installed") log.info(`  skip ${r.name}: not installed`);
    else {
      failed++;
      log.error(`  FAIL ${r.name}: ${r.message || "command failed"}`);
    }
  }
  if (failed > 0) process.exit(1);
}

const marketplaceAddCmd = defineCommand({
  meta: { name: "add", description: "Register a marketplace with every installed harness" },
  args: {
    source: {
      type: "positional",
      required: true,
      description: "owner/repo, a URL, or a local path to the marketplace",
    },
    target: { type: "string", description: "Comma-separated targets (default: all registered)" },
  },
  async run({ args }) {
    try {
      log.info(`Registering marketplace ${args.source}:`);
      reportMarketplace(await marketplaceAdd(adaptersFor(args.target), args.source));
    } catch (err) {
      fail(err);
    }
  },
});

const marketplaceRemoveCmd = defineCommand({
  meta: { name: "remove", description: "Remove a registered marketplace from every harness" },
  args: {
    name: { type: "positional", required: true, description: "The marketplace name to remove" },
    target: { type: "string", description: "Comma-separated targets (default: all registered)" },
  },
  async run({ args }) {
    try {
      log.info(`Removing marketplace ${args.name}:`);
      reportMarketplace(await marketplaceRemove(adaptersFor(args.target), args.name));
    } catch (err) {
      fail(err);
    }
  },
});

const marketplaceInstallCmd = defineCommand({
  meta: {
    name: "install",
    description: "Install a plugin from a registered marketplace on every harness",
  },
  args: {
    plugin: {
      type: "positional",
      required: true,
      description: "Plugin name, or plugin@marketplace",
    },
    marketplace: {
      type: "string",
      alias: "m",
      description: "Marketplace name (if not in plugin@mkt)",
    },
    target: { type: "string", description: "Comma-separated targets (default: all registered)" },
  },
  async run({ args }) {
    try {
      let plugin = args.plugin;
      let marketplace = args.marketplace;
      const at = plugin.lastIndexOf("@");
      if (at > 0) {
        if (!marketplace) marketplace = plugin.slice(at + 1);
        plugin = plugin.slice(0, at);
      }
      if (!marketplace) {
        log.error(
          "specify the marketplace: `weft marketplace install <plugin>@<marketplace>` or --marketplace <name>",
        );
        process.exit(1);
      }
      log.info(`Installing ${plugin} from ${marketplace}:`);
      reportMarketplace(await marketplaceInstall(adaptersFor(args.target), plugin, marketplace));
    } catch (err) {
      fail(err);
    }
  },
});

const marketplaceCmd = defineCommand({
  meta: {
    name: "marketplace",
    description: "Drive each harness's native marketplace CLI (register/install everywhere)",
  },
  subCommands: {
    add: marketplaceAddCmd,
    remove: marketplaceRemoveCmd,
    install: marketplaceInstallCmd,
  },
});

const main = defineCommand({
  meta: {
    name: "weft",
    version: WEFT_VERSION,
    description: "Author once, compile to every coding-agent harness.",
  },
  subCommands: {
    init: initCmd,
    validate: validateCmd,
    build: buildCmd,
    install: installCmd,
    uninstall: uninstallCmd,
    update: updateCmd,
    import: importCmd,
    marketplace: marketplaceCmd,
    eval: evalCmd,
    publish: publishCmd,
    sign: signCmd,
    verify: verifyCmd,
    index: indexCmd,
    docs: docsCmd,
  },
});

runMain(main);
