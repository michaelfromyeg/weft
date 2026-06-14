import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ArtifactKind,
  HarnessAdapter,
  ResolvedMarketplace,
} from "@michaelfromyeg/weft-adapter-kit";
import type { ArtifactRecord, Scope, Target } from "@michaelfromyeg/weft-schema";
import { type CompileResult, synthMarketplace, type TargetOutput } from "./compile";
import { sha256 } from "./hash";

export interface WrittenArtifact {
  target: Target;
  /** Relative to the per-target output base. */
  relPath: string;
  abs: string;
  hash: string;
  kind?: ArtifactKind;
}

/** A planned artifact: where it would land and its content hash, not yet written. */
export interface PlannedWrite extends WrittenArtifact {
  contents: Buffer;
}

/** Where one plugin's artifacts would land under `<baseDir>/plugins/<pluginName>/`, with hashes. */
export function planPluginArtifacts(
  target: TargetOutput,
  baseDir: string,
  pluginName: string,
): PlannedWrite[] {
  // Flat adapters drop the plugins/<name>/ grouping (directory-convention harnesses).
  return target.artifacts.map(({ artifact }) => {
    const rel = target.adapter.flat
      ? artifact.relPath
      : join("plugins", pluginName, artifact.relPath);
    const contents = toBuffer(artifact.contents);
    return {
      target: target.target,
      relPath: rel,
      abs: join(baseDir, rel),
      hash: sha256(contents),
      kind: artifact.kind,
      contents,
    };
  });
}

/** Where a harness's native catalog would land at `<baseDir>/`, with hashes. */
export function planCatalog(
  adapter: HarnessAdapter,
  marketplace: ResolvedMarketplace,
  baseDir: string,
): PlannedWrite[] {
  return adapter.emitCatalog(marketplace).map((artifact) => {
    const contents = toBuffer(artifact.contents);
    return {
      target: adapter.target,
      relPath: artifact.relPath,
      abs: join(baseDir, artifact.relPath),
      hash: sha256(contents),
      kind: artifact.kind,
      contents,
    };
  });
}

/**
 * `weft build` placement plan for a single plugin (spec §9.1 step 6, inspect-only):
 * the plugin tree at `outDir/<target>/plugins/<plugin>/` plus a synthetic one-entry
 * catalog at the target root. `bare` writes straight to outDir (one target only) so a
 * repo root becomes the harness's native marketplace.
 */
export function planBuild(result: CompileResult, outDir: string, bare = false): PlannedWrite[] {
  const planned: PlannedWrite[] = [];
  const { plugin } = result.fb;
  const marketplace = synthMarketplace(plugin);
  for (const t of result.targets) {
    const base = bare ? outDir : join(outDir, t.target);
    planned.push(...planPluginArtifacts(t, base, plugin.name));
    planned.push(...planCatalog(t.adapter, marketplace, base));
  }
  return planned;
}

/**
 * Relative paths that two or more targets would write with DIFFERENT content when
 * unioned into one `--out` (multi-target `--bare`). Identical content at the same
 * path is fine (e.g. a shared SKILL.md); only a genuine content clash is a problem.
 */
export function findPlanConflicts(planned: PlannedWrite[]): string[] {
  const hashByAbs = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const p of planned) {
    const prev = hashByAbs.get(p.abs);
    if (prev === undefined) hashByAbs.set(p.abs, p.hash);
    else if (prev !== p.hash) conflicts.add(p.relPath);
  }
  return [...conflicts].sort();
}

/**
 * Drop duplicate planned writes that target the same path (first wins), so a
 * union build writes each shared file once. Call only after `findPlanConflicts`
 * has confirmed every same-path pair is byte-identical.
 */
export function dedupePlanned(planned: PlannedWrite[]): PlannedWrite[] {
  const seen = new Set<string>();
  const unique: PlannedWrite[] = [];
  for (const p of planned) {
    if (seen.has(p.abs)) continue;
    seen.add(p.abs);
    unique.push(p);
  }
  return unique;
}

/** Write each planned artifact to disk (mkdir as needed); drops `contents` from the result. */
export function writePlanned(planned: PlannedWrite[]): WrittenArtifact[] {
  return planned.map(({ contents, ...rest }) => {
    mkdirSync(dirname(rest.abs), { recursive: true });
    writeFileSync(rest.abs, contents);
    return rest;
  });
}

export interface DriftReport {
  clean: boolean;
  /** relPaths the build would create that are absent on disk. */
  missing: string[];
  /** relPaths whose on-disk content differs from the compiled artifact. */
  stale: string[];
  /** Total artifacts compared. */
  checked: number;
}

/**
 * Compare a build plan against what is on disk, reading only (never writes). Backs
 * `weft build --check`: a committed `--bare` marketplace that drifted from source
 * shows up as `stale`/`missing` so CI can fail before publish. Does NOT detect
 * orphans (files a prior build wrote that this one no longer would) -- that needs
 * the lockfile's history and belongs to `weft diff`.
 */
export function diffPlanned(planned: PlannedWrite[]): DriftReport {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const p of planned) {
    if (!existsSync(p.abs)) missing.push(p.relPath);
    else if (sha256(readFileSync(p.abs)) !== p.hash) stale.push(p.relPath);
  }
  return {
    clean: missing.length === 0 && stale.length === 0,
    missing,
    stale,
    checked: planned.length,
  };
}

/** Write one plugin's artifacts under `<baseDir>/plugins/<pluginName>/`. */
export function placePluginArtifacts(
  target: TargetOutput,
  baseDir: string,
  pluginName: string,
): WrittenArtifact[] {
  return writePlanned(planPluginArtifacts(target, baseDir, pluginName));
}

/** Emit and write a harness's native catalog at `<baseDir>/`. */
export function placeCatalog(
  adapter: HarnessAdapter,
  marketplace: ResolvedMarketplace,
  baseDir: string,
): WrittenArtifact[] {
  return writePlanned(planCatalog(adapter, marketplace, baseDir));
}

/** Compile-and-write a single plugin's build output (write-mode `weft build`). */
export function buildToDir(result: CompileResult, outDir: string, bare = false): WrittenArtifact[] {
  return writePlanned(planBuild(result, outDir, bare));
}

function toBuffer(contents: string | Buffer): Buffer {
  return typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
}

export interface PlannedArtifact {
  record: ArtifactRecord;
  contents: Buffer;
}

/**
 * Compute (without writing) where each target's plugin tree would land in the
 * scope, with content hashes. Drives both install (write all) and update (write
 * only what changed). Executable/passthrough artifacts are recorded DISABLED (§11).
 */
export function planScopeArtifacts(
  result: CompileResult,
  scope: Scope,
  cwd: string,
): PlannedArtifact[] {
  const planned: PlannedArtifact[] = [];
  const name = result.fb.plugin.name;
  for (const t of result.targets) {
    const paths = t.adapter.detect(scope, cwd);
    // Flat adapters place under the scope dir directly, no plugins/<name>/ grouping.
    const pluginDir = t.adapter.flat ? paths.plugins : join(paths.plugins, name);
    for (const { componentId, artifact } of t.artifacts) {
      const contents = toBuffer(artifact.contents);
      planned.push({
        contents,
        record: {
          plugin: result.id,
          component: componentId,
          target: t.target,
          scope,
          path: join(pluginDir, artifact.relPath),
          hash: sha256(contents),
          placement: "copy",
          enabled: artifact.executable !== true,
        },
      });
    }
  }
  return planned;
}

/** `weft install` placement (spec §9.1 step 6): write every artifact, record each. */
export function installToScope(result: CompileResult, scope: Scope, cwd: string): ArtifactRecord[] {
  return planScopeArtifacts(result, scope, cwd).map(({ record, contents }) => {
    mkdirSync(dirname(record.path), { recursive: true });
    writeFileSync(record.path, contents);
    return record;
  });
}
