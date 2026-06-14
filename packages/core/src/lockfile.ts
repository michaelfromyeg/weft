import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactRecord,
  Lockfile,
  type PluginLock,
  type Scope,
  validate,
} from "@michaelfromyeg/weft-schema";
import type { CompileResult } from "./compile";
import { WEFT_VERSION } from "./version";

/** One plugin's contribution to a lockfile: its record, placed artifacts, and adapters used. */
export interface LockEntry {
  pluginLock: PluginLock;
  artifacts: ArtifactRecord[];
  adapters: Lockfile["adapters"];
}

export interface LockEntryInput {
  result: CompileResult;
  artifacts: ArtifactRecord[];
  ref: string;
  sha: string;
  dependencies?: PluginLock["dependencies"];
}

/** Build one plugin's lock entry from its compiled result and placement (spec §6.3). */
export function buildLockEntry(input: LockEntryInput): LockEntry {
  const adapters: Lockfile["adapters"] = {};
  for (const t of input.result.targets) {
    adapters[t.target] = {
      version: t.adapter.version,
      targetSchema: t.adapter.targetSchema,
      ...(t.adapter.harness ? { harnessRange: t.adapter.harness.range } : {}),
    };
  }
  return {
    pluginLock: {
      id: input.result.id,
      version: input.result.fb.plugin.version,
      ref: input.ref,
      sha: input.sha,
      dependencies: input.dependencies ?? [],
      aliases: input.result.aliases,
    },
    artifacts: input.artifacts,
    adapters,
  };
}

/**
 * Merge install entries into an existing target lockfile (or a fresh one),
 * upserting by plugin id: a re-installed plugin replaces its prior record and
 * artifacts, leaving every other installed plugin in the ledger untouched.
 */
export function mergeLock(
  existing: Lockfile | null,
  entries: LockEntry[],
  generatedAt: string,
): Lockfile {
  const replacing = new Set(entries.map((e) => e.pluginLock.id));
  const plugins = (existing?.plugins ?? []).filter((p) => !replacing.has(p.id));
  const artifacts = (existing?.artifacts ?? []).filter((a) => !replacing.has(a.plugin));
  const adapters: Lockfile["adapters"] = { ...(existing?.adapters ?? {}) };
  for (const e of entries) {
    plugins.push(e.pluginLock);
    artifacts.push(...e.artifacts);
    Object.assign(adapters, e.adapters);
  }
  return { weftVersion: WEFT_VERSION, generatedAt, plugins, artifacts, adapters };
}

/**
 * Where a target's `weft.lock` lives: the project root for project scope, a
 * per-user dir for user scope. The lock travels with the install target, not the
 * (possibly remote, read-only) source.
 */
export function lockDirForScope(scope: Scope, cwd: string): string {
  return scope === "user" ? join(homedir(), ".weft") : cwd;
}

export function serializeLock(lock: Lockfile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function writeLock(dir: string, lock: Lockfile): string {
  const p = join(dir, "weft.lock");
  writeFileSync(p, serializeLock(lock));
  return p;
}

/** Read and validate an existing lockfile; null when absent or malformed. */
export function readLock(dir: string): Lockfile | null {
  try {
    const text = readFileSync(join(dir, "weft.lock"), "utf8");
    const res = validate(Lockfile, JSON.parse(text));
    return res.ok ? res.value : null;
  } catch {
    return null;
  }
}
