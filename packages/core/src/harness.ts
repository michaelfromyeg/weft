import { execSync } from "node:child_process";
import type { HarnessAdapter } from "@michaelfromyeg/weft-adapter-kit";
import type { Target } from "@michaelfromyeg/weft-schema";
import semver from "semver";

/**
 * The result of comparing an installed/declared harness version against the
 * range an adapter's emitted format is verified for (versioning axis 4, spec §5).
 */
export interface HarnessCheck {
  target: Target;
  /** Human-facing harness name (from the adapter). */
  name: string;
  /** Supported semver range the adapter's format is known-good for. */
  range: string;
  /** The version compared against `range`; null when undeclared and undetectable. */
  version: string | null;
  /** Where `version` came from. */
  source: "declared" | "detected" | "unknown";
  /** true/false once a version is known; null when none could be determined. */
  satisfied: boolean | null;
}

/**
 * Best-effort: run the adapter's `versionCommand` and coerce a semver from its
 * output. Returns null on any failure (binary absent, non-zero exit, no semver
 * in the output) -- a harness we can't see is simply not checked, never an error.
 */
export function detectHarnessVersion(versionCommand: string): string | null {
  try {
    const out = execSync(versionCommand, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString();
    return semver.coerce(out)?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare the harness version against the adapter's supported `range`. A caller-
 * `declared` version (e.g. from `--harness codex@0.130`, the CI path) wins over
 * auto-detection; `detect=false` skips spawning the version command for hermetic
 * builds. Returns null for adapters that declare no `harness` block.
 */
export function checkHarness(
  adapter: HarnessAdapter,
  declared: string | undefined,
  detect: boolean,
): HarnessCheck | null {
  const h = adapter.harness;
  if (!h) return null;

  let version: string | null = null;
  let source: HarnessCheck["source"] = "unknown";
  if (declared) {
    version = semver.coerce(declared)?.version ?? null;
    if (version) source = "declared";
  } else if (detect && h.versionCommand) {
    version = detectHarnessVersion(h.versionCommand);
    if (version) source = "detected";
  }

  return {
    target: adapter.target,
    name: h.name,
    range: h.range,
    version,
    source,
    satisfied: version ? semver.satisfies(version, h.range) : null,
  };
}

/** Run {@link checkHarness} for each adapter, dropping those without a `harness` block. */
export function checkHarnesses(
  adapters: HarnessAdapter[],
  declared: Record<string, string> | undefined,
  detect: boolean,
): HarnessCheck[] {
  const checks: HarnessCheck[] = [];
  for (const adapter of adapters) {
    const check = checkHarness(adapter, declared?.[adapter.target], detect);
    if (check) checks.push(check);
  }
  return checks;
}
