import semver from "semver";

/** The Weft/CLI version (versioning axis 2, spec §5). */
export const WEFT_VERSION = "1.5.1";

/**
 * Check a plugin's `weft_min_version` against the running Weft. Returns an error
 * message when unmet, or null when satisfied / unspecified.
 */
export function checkMinVersion(min: string | undefined): string | null {
  if (!min) return null;
  const cleaned = semver.valid(semver.coerce(min) ?? min);
  if (!cleaned) return `weft_min_version "${min}" is not a valid semver`;
  if (semver.lt(WEFT_VERSION, cleaned)) {
    return `plugin requires Weft >= ${min}, but this is ${WEFT_VERSION}`;
  }
  return null;
}
