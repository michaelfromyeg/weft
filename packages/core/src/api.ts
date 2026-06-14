import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CatalogEntry, ResolvedMarketplace } from "@michaelfromyeg/weft-adapter-kit";
import type {
  Badge,
  Lockfile,
  Marketplace,
  ParseIssue,
  Plugin,
  Scope,
  Target,
} from "@michaelfromyeg/weft-schema";
import { type CompileResult, compile, staticPass } from "./compile";
import { resolveConfig, type SecretsResult } from "./config";
import { type DependencyRecord, resolveDependencies } from "./deps";
import { CompileError, type Diagnostic, type Diagnostics } from "./diagnostics";
import { checkHarnesses, type HarnessCheck } from "./harness";
import { type FetchedPlugin, loadMarketplaceDir, loadPluginDir } from "./loader";
import {
  buildLockEntry,
  type LockEntry,
  lockDirForScope,
  mergeLock,
  readLock,
  writeLock,
} from "./lockfile";
import { checkManagedPolicy, type ManagedPolicy } from "./managed";
import {
  type DriftReport,
  diffPlanned,
  installToScope,
  type PlannedWrite,
  planBuild,
  planCatalog,
  planPluginArtifacts,
  planScopeArtifacts,
  type WrittenArtifact,
  writePlanned,
} from "./place";
import type { AdapterRegistry } from "./registry";
import { gitInfo, type ResolvedPlugin, resolvePluginRefFull } from "./resolve";

/** Load a plugin and resolve its `depends` into a merged tree (spec §9.1 step 2). */
function loadResolved(
  pluginDir: string,
): Promise<{ fb: FetchedPlugin; dependencies: DependencyRecord[] }> {
  return resolveDependencies(loadOrThrow(pluginDir));
}

function issuesToDiagnostics(issues: ParseIssue[]): Diagnostic[] {
  return issues.map((i) => ({ severity: "error", where: i.path, message: i.message }));
}

function loadOrThrow(pluginDir: string) {
  const loaded = loadPluginDir(pluginDir);
  if (!loaded.ok) {
    throw new CompileError(
      `failed to load plugin in ${pluginDir}`,
      issuesToDiagnostics(loaded.issues),
    );
  }
  return loaded.value;
}

export interface LintResult {
  id: string;
  plugin: Plugin;
  aliases: Record<string, string>;
  diagnostics: Diagnostics;
}

/** Load + statically validate a plugin without running any adapter (the valid badge). */
export function lint(pluginDir: string): LintResult {
  const fb = loadOrThrow(pluginDir);
  const pass = staticPass(fb);
  return { id: pass.id, plugin: fb.plugin, aliases: pass.aliases, diagnostics: pass.diagnostics };
}

export interface BuildOptions {
  pluginDir: string;
  outDir: string;
  registry: AdapterRegistry;
  targets?: Target[];
  /** Write straight to outDir without the <target>/ subdir (single target only). */
  bare?: boolean;
  /** Compare against on-disk output instead of writing; populates `drift`, writes nothing. */
  check?: boolean;
  /** Per-target harness version to compare against (e.g. {codex: "0.130"}); skips detection. */
  harnessVersions?: Record<string, string>;
  /** Set true to detect installed harness versions via their CLIs (the CLI enables this;
   * off by default so the library stays hermetic). Declared `harnessVersions` are always checked. */
  harnessCheck?: boolean;
}

export interface BuildResult {
  result: CompileResult;
  /** The artifacts written (or, in check mode, the artifacts a write would produce). */
  written: WrittenArtifact[];
  /** Present only in check mode: how the on-disk output differs from a fresh compile. */
  drift?: DriftReport;
  /** Harness version-compat findings, one per built target that declares a `harness` (axis 4). */
  harnessChecks: HarnessCheck[];
}

/** Drop the planned contents so a plan can be reported as `written` (check mode). */
function asWritten(planned: PlannedWrite[]): WrittenArtifact[] {
  return planned.map(({ contents: _contents, ...rest }) => rest);
}

/** Compile a plugin and write its marketplace + plugin layout into `outDir` (no install). */
export async function build(opts: BuildOptions): Promise<BuildResult> {
  const { fb } = await loadResolved(opts.pluginDir);
  const result = compile(fb, { registry: opts.registry, targets: opts.targets });
  if (result.diagnostics.hasErrors) {
    throw new CompileError("compile failed", result.diagnostics.errors);
  }
  const harnessChecks = checkHarnesses(
    result.targets.map((t) => t.adapter),
    opts.harnessVersions,
    opts.harnessCheck === true,
  );
  const planned = planBuild(result, opts.outDir, opts.bare);
  if (opts.check) {
    return { result, written: asWritten(planned), drift: diffPlanned(planned), harnessChecks };
  }
  return { result, written: writePlanned(planned), harnessChecks };
}

export interface BuildMarketplaceOptions {
  marketplaceDir: string;
  outDir: string;
  registry: AdapterRegistry;
  targets?: Target[];
  /** Write straight to outDir without the <target>/ subdir (single target only). */
  bare?: boolean;
  /** Compare against on-disk output instead of writing; populates `drift`, writes nothing. */
  check?: boolean;
  /** Per-target harness version to compare against (e.g. {codex: "0.130"}); skips detection. */
  harnessVersions?: Record<string, string>;
  /** Set true to detect installed harness versions via their CLIs (the CLI enables this;
   * off by default so the library stays hermetic). Declared `harnessVersions` are always checked. */
  harnessCheck?: boolean;
}

export interface BuildMarketplaceResult {
  marketplace: Marketplace;
  plugins: CompileResult[];
  /** The artifacts written (or, in check mode, the artifacts a write would produce). */
  written: WrittenArtifact[];
  /** Present only in check mode: how the on-disk output differs from a fresh compile. */
  drift?: DriftReport;
  /** Harness version-compat findings, one per built target that declares a `harness` (axis 4). */
  harnessChecks: HarnessCheck[];
}

/**
 * Compile a curated `marketplace.yaml` of many plugins: resolve and compile each
 * referenced plugin, place every plugin tree under `outDir/<target>/plugins/`,
 * and emit ONE native catalog per target listing them all (spec §6.2). This is
 * the company-marketplace workflow.
 */
export async function buildMarketplace(
  opts: BuildMarketplaceOptions,
): Promise<BuildMarketplaceResult> {
  const loaded = loadMarketplaceDir(opts.marketplaceDir);
  if (!loaded.ok) {
    throw new CompileError(
      `failed to load marketplace in ${opts.marketplaceDir}`,
      issuesToDiagnostics(loaded.issues),
    );
  }
  const { marketplace, root } = loaded.value;

  const compiled: Array<{ entry: Marketplace["plugins"][number]; result: CompileResult }> = [];
  for (const entry of marketplace.plugins) {
    let fb: FetchedPlugin;
    try {
      fb = (await resolvePluginRefFull(entry.plugin, root)).fb;
    } catch (err) {
      throw new CompileError(`marketplace entry "${entry.plugin}" failed`, [
        { severity: "error", where: "plugins", message: (err as Error).message },
      ]);
    }
    // An entry version override flows into the compiled plugin.json too, so the
    // catalog and the plugin manifest agree (plugin.json wins at install time).
    if (entry.version) fb = { ...fb, plugin: { ...fb.plugin, version: entry.version } };
    // Resolve the entry plugin's own dependencies before compiling it.
    const merged = (await resolveDependencies(fb)).fb;
    const result = compile(merged, { registry: opts.registry, targets: opts.targets });
    if (result.diagnostics.hasErrors) {
      throw new CompileError(`plugin "${result.id}" failed`, result.diagnostics.errors);
    }
    compiled.push({ entry, result });
  }

  const targets = opts.targets ?? opts.registry.targets;
  const planned: PlannedWrite[] = [];
  for (const target of targets) {
    const adapter = opts.registry.get(target);
    if (!adapter) continue;
    const base = opts.bare ? opts.outDir : join(opts.outDir, target);
    const entries: CatalogEntry[] = [];
    for (const { entry, result } of compiled) {
      const output = result.targets.find((t) => t.target === target);
      if (!output) continue;
      const p = result.fb.plugin;
      planned.push(...planPluginArtifacts(output, base, p.name));
      entries.push({
        name: p.name,
        source: `./plugins/${p.name}`,
        ...(p.description ? { description: p.description } : {}),
        version: entry.version ?? p.version,
        ...(entry.category ? { category: entry.category } : {}),
        ...(entry.tags ? { tags: entry.tags } : {}),
      });
    }
    const resolved: ResolvedMarketplace = {
      name: marketplace.name,
      owner: marketplace.owner,
      ...(marketplace.description ? { description: marketplace.description } : {}),
      entries,
    };
    planned.push(...planCatalog(adapter, resolved, base));
  }

  const adapters = targets
    .map((t) => opts.registry.get(t))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);
  const harnessChecks = checkHarnesses(adapters, opts.harnessVersions, opts.harnessCheck === true);

  const plugins = compiled.map((c) => c.result);
  if (opts.check) {
    return {
      marketplace,
      plugins,
      written: asWritten(planned),
      drift: diffPlanned(planned),
      harnessChecks,
    };
  }
  return { marketplace, plugins, written: writePlanned(planned), harnessChecks };
}

export interface InstallOptions {
  pluginDir: string;
  scope: Scope;
  cwd: string;
  registry: AdapterRegistry;
  targets?: Target[];
  /** Piecemeal: install only these component leaf names (spec §9.2). */
  only?: string[];
  /** Managed-mode policy: namespace allowlist / required badges (spec §11). */
  managed?: ManagedPolicy;
  /** Badges known for this plugin (for managed `requireBadges`). */
  badges?: Badge[];
  /** Where to write `weft.lock` (default: the plugin dir). Eval points this at a scratch dir. */
  lockDir?: string;
  /** Inject the lockfile timestamp for deterministic tests. */
  now?: string;
}

/** One plugin's install output: its compiled result, lock entry, and config summary. */
export interface PluginInstall {
  result: CompileResult;
  entry: LockEntry;
  /** Declared config resolution summary (never the values) -- spec §11. */
  secrets: SecretsResult;
}

export interface InstallResult extends PluginInstall {
  /** The merged target lockfile (every plugin installed into this target). */
  lockfile: Lockfile;
  lockPath: string;
}

/** Compile an already-resolved plugin and place it into the scope (no lock write). */
function installResolved(
  fb: FetchedPlugin,
  dependencies: DependencyRecord[],
  opts: {
    scope: Scope;
    cwd: string;
    registry: AdapterRegistry;
    targets?: Target[];
    only?: string[];
    managed?: ManagedPolicy;
    badges?: Badge[];
    ref: string;
    sha: string;
  },
): PluginInstall {
  const result = compile(fb, { registry: opts.registry, targets: opts.targets, only: opts.only });
  if (result.diagnostics.hasErrors) {
    throw new CompileError("compile failed", result.diagnostics.errors);
  }
  // Managed mode gates the install by namespace / required badges (spec §11).
  const blocked = checkManagedPolicy(opts.managed, {
    namespace: result.fb.plugin.owner.namespace,
    badges: opts.badges,
  });
  if (blocked) {
    throw new CompileError("install blocked by managed policy", [
      { severity: "error", where: "managed", message: blocked },
    ]);
  }
  const artifacts = installToScope(result, opts.scope, opts.cwd);
  const secrets = resolveConfig(result.fb.plugin, opts.cwd);
  const entry = buildLockEntry({ result, artifacts, dependencies, ref: opts.ref, sha: opts.sha });
  return { result, entry, secrets };
}

/** Merge install entries into the target's `weft.lock` and write it once. */
function commitLock(
  scope: Scope,
  cwd: string,
  entries: LockEntry[],
  now: string | undefined,
  lockDirOverride: string | undefined,
): { lockfile: Lockfile; lockPath: string } {
  const dir = lockDirOverride ?? lockDirForScope(scope, cwd);
  mkdirSync(dir, { recursive: true });
  const lockfile = mergeLock(readLock(dir), entries, now ?? new Date().toISOString());
  return { lockfile, lockPath: writeLock(dir, lockfile) };
}

/** Compile a plugin, place it into the scope, resolve config, write the target `weft.lock`. */
export async function install(opts: InstallOptions): Promise<InstallResult> {
  const { fb, dependencies } = await loadResolved(opts.pluginDir);
  const { ref, sha } = await gitInfo(opts.pluginDir);
  const pi = installResolved(fb, dependencies, {
    scope: opts.scope,
    cwd: opts.cwd,
    registry: opts.registry,
    ref,
    sha,
    targets: opts.targets,
    only: opts.only,
    managed: opts.managed,
    badges: opts.badges,
  });
  const { lockfile, lockPath } = commitLock(
    opts.scope,
    opts.cwd,
    [pi.entry],
    opts.now,
    opts.lockDir,
  );
  return { ...pi, lockfile, lockPath };
}

export interface InstallMarketplaceOptions {
  marketplaceDir: string;
  scope: Scope;
  cwd: string;
  registry: AdapterRegistry;
  targets?: Target[];
  managed?: ManagedPolicy;
  lockDir?: string;
  now?: string;
}

export interface InstallMarketplaceResult {
  marketplace: Marketplace;
  /** The merged target lockfile recording every installed plugin. */
  lockfile: Lockfile;
  lockPath: string;
  /** One install per marketplace plugin, in catalog order. */
  installs: PluginInstall[];
}

/**
 * Install every plugin in a marketplace into the scope in one pass (the
 * company-marketplace install). Each plugin is resolved (local or remote),
 * compiled, and placed; all of them land in a single target `weft.lock`,
 * mirroring a single-plugin install at marketplace scale (same primitives).
 */
export async function installMarketplace(
  opts: InstallMarketplaceOptions,
): Promise<InstallMarketplaceResult> {
  const loaded = loadMarketplaceDir(opts.marketplaceDir);
  if (!loaded.ok) {
    throw new CompileError(
      `failed to load marketplace in ${opts.marketplaceDir}`,
      issuesToDiagnostics(loaded.issues),
    );
  }
  const { marketplace, root } = loaded.value;

  const installs: PluginInstall[] = [];
  for (const entry of marketplace.plugins) {
    let resolved: ResolvedPlugin;
    try {
      resolved = await resolvePluginRefFull(entry.plugin, root);
    } catch (err) {
      throw new CompileError(`marketplace entry "${entry.plugin}" failed`, [
        { severity: "error", where: "plugins", message: (err as Error).message },
      ]);
    }
    // An entry version override flows into the installed plugin (catalog wins).
    let fb = resolved.fb;
    if (entry.version) fb = { ...fb, plugin: { ...fb.plugin, version: entry.version } };
    const { fb: merged, dependencies } = await resolveDependencies(fb);
    installs.push(
      installResolved(merged, dependencies, {
        scope: opts.scope,
        cwd: opts.cwd,
        registry: opts.registry,
        ref: resolved.ref,
        sha: resolved.sha,
        targets: opts.targets,
        managed: opts.managed,
      }),
    );
  }
  const { lockfile, lockPath } = commitLock(
    opts.scope,
    opts.cwd,
    installs.map((i) => i.entry),
    opts.now,
    opts.lockDir,
  );
  return { marketplace, lockfile, lockPath, installs };
}

export interface UninstallOptions {
  /** The install target that holds weft.lock (project root for project scope). */
  dir: string;
  /** Optionally remove just one plugin (by id or bare name); default removes all. */
  plugin?: string;
}

export interface UninstallResult {
  removed: string[];
  /** Plugin ids removed from the lock. */
  plugins: string[];
}

/** Prune now-empty directories upward from each removed file (best-effort). */
function pruneEmptyDirs(paths: string[]): void {
  const dirs = new Set(paths.map((p) => dirname(p)));
  for (const start of dirs) {
    let d = start;
    while (d && d !== dirname(d)) {
      try {
        if (readdirSync(d).length > 0) break;
        rmSync(d, { recursive: true, force: true });
      } catch {
        break;
      }
      d = dirname(d);
    }
  }
}

/**
 * Remove what `install` placed into a target, using the paths recorded in the
 * target's `weft.lock` (spec §6.3). Removes one plugin (by id or bare name) or
 * all of them; deletes the lock when nothing is left, else rewrites the rest.
 * Errors are defined out of existence: a missing artifact is simply skipped.
 */
export function uninstall(opts: UninstallOptions): UninstallResult {
  const lock = readLock(opts.dir);
  if (!lock) {
    throw new CompileError("nothing to uninstall", [
      { severity: "error", where: "weft.lock", message: `no weft.lock found in ${opts.dir}` },
    ]);
  }
  const match = opts.plugin;
  const ids = new Set(
    (match
      ? lock.plugins.filter((p) => p.id === match || p.id.endsWith(`/${match}`))
      : lock.plugins
    ).map((p) => p.id),
  );
  if (match && ids.size === 0) {
    throw new CompileError(`plugin "${match}" is not installed here`, [
      { severity: "error", where: "weft.lock", message: `no plugin matching "${match}"` },
    ]);
  }

  const removed: string[] = [];
  for (const a of lock.artifacts) {
    if (!ids.has(a.plugin)) continue;
    if (existsSync(a.path)) {
      rmSync(a.path, { force: true });
      removed.push(a.path);
    }
  }
  pruneEmptyDirs(removed);

  const remaining = lock.plugins.filter((p) => !ids.has(p.id));
  if (remaining.length === 0) {
    rmSync(join(opts.dir, "weft.lock"), { force: true });
  } else {
    writeLock(opts.dir, {
      ...lock,
      plugins: remaining,
      artifacts: lock.artifacts.filter((a) => !ids.has(a.plugin)),
    });
  }
  return { removed, plugins: [...ids] };
}

export interface UpdateResult {
  /** The recompiled plugin's id. */
  id: string;
  lockfile: Lockfile;
  lockPath: string;
  /** Artifacts whose content hash changed (or are new) since the prior lockfile. */
  changed: string[];
}

/**
 * Re-resolve refs, recompile a plugin source, diff its artifact content hashes
 * against the target `weft.lock`, and re-place ONLY changed artifacts (spec §5,
 * §9.3); its entry is then merged back into the target lock. Content addressing
 * makes "is there really a new version?" exact: unchanged artifacts are not rewritten.
 */
export async function update(opts: InstallOptions): Promise<UpdateResult> {
  const lockDir = opts.lockDir ?? lockDirForScope(opts.scope, opts.cwd);
  const prev = readLock(lockDir);

  const { fb, dependencies } = await loadResolved(opts.pluginDir);
  const result = compile(fb, { registry: opts.registry, targets: opts.targets, only: opts.only });
  if (result.diagnostics.hasErrors) {
    throw new CompileError("compile failed", result.diagnostics.errors);
  }

  // Diff against this plugin's prior artifacts only; other plugins in the lock are untouched.
  const prevHash = new Map(
    (prev?.artifacts ?? []).filter((a) => a.plugin === result.id).map((a) => [a.path, a.hash]),
  );
  const planned = planScopeArtifacts(result, opts.scope, opts.cwd);
  const changed: string[] = [];
  for (const { record, contents } of planned) {
    if (prevHash.get(record.path) === record.hash) continue; // unchanged -> never rewrite
    mkdirSync(dirname(record.path), { recursive: true });
    writeFileSync(record.path, contents);
    changed.push(record.path);
  }

  const { ref, sha } = await gitInfo(opts.pluginDir);
  const entry = buildLockEntry({
    result,
    artifacts: planned.map((p) => p.record),
    dependencies,
    ref,
    sha,
  });
  mkdirSync(lockDir, { recursive: true });
  const lockfile = mergeLock(prev, [entry], opts.now ?? new Date().toISOString());
  const lockPath = writeLock(lockDir, lockfile);
  return { id: result.id, lockfile, lockPath, changed };
}
