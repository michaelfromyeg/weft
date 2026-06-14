import type { HarnessAdapter, HarnessCompat } from "@michaelfromyeg/weft-adapter-kit";
import { describe, expect, it } from "vitest";
import { checkHarness, checkHarnesses, detectHarnessVersion } from "../src/harness";

/** A stub adapter carrying only the fields checkHarness reads (target + harness). */
function adapter(target: string, harness?: HarnessCompat): HarnessAdapter {
  return { target, harness } as unknown as HarnessAdapter;
}

const codexLike: HarnessCompat = {
  name: "Codex CLI",
  versionCommand: "codex --version",
  range: ">=0.121.0 <0.130.0",
};

describe("checkHarness", () => {
  it("returns null for an adapter with no harness block", () => {
    expect(checkHarness(adapter("opencode"), undefined, true)).toBeNull();
  });

  it("a declared in-range version is satisfied (no detection needed)", () => {
    const c = checkHarness(adapter("codex", codexLike), "0.125.0", false);
    expect(c).toMatchObject({
      target: "codex",
      version: "0.125.0",
      source: "declared",
      satisfied: true,
    });
  });

  it("a declared out-of-range version is not satisfied", () => {
    const c = checkHarness(adapter("codex", codexLike), "0.140.0", false);
    expect(c).toMatchObject({ version: "0.140.0", source: "declared", satisfied: false });
  });

  it("coerces a loose declared version (0.121 -> 0.121.0)", () => {
    const c = checkHarness(adapter("codex", codexLike), "0.121", false);
    expect(c?.version).toBe("0.121.0");
    expect(c?.satisfied).toBe(true);
  });

  it("declared wins over detection, and a declared version is checked even with detect off", () => {
    const c = checkHarness(adapter("codex", codexLike), "0.125.0", false);
    expect(c?.source).toBe("declared");
  });

  it("with no declared version and detection off, records nothing to compare", () => {
    const c = checkHarness(adapter("codex", codexLike), undefined, false);
    expect(c).toMatchObject({ version: null, source: "unknown", satisfied: null });
  });
});

describe("detectHarnessVersion", () => {
  it("coerces a semver from a real command's output", () => {
    // `node --version` prints e.g. "v22.10.0"; coercion strips the leading v.
    const v = detectHarnessVersion("node --version");
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns null when the command does not exist", () => {
    expect(detectHarnessVersion("weft-no-such-binary-xyz --version")).toBeNull();
  });
});

describe("checkHarnesses", () => {
  it("checks each adapter and drops those without a harness block", () => {
    const checks = checkHarnesses(
      [adapter("codex", codexLike), adapter("opencode")],
      { codex: "0.140.0" },
      false,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ target: "codex", satisfied: false });
  });
});
