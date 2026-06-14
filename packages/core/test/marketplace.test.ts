import claudeAdapter from "@michaelfromyeg/weft-adapter-claude";
import codexAdapter from "@michaelfromyeg/weft-adapter-codex";
import type { HarnessAdapter } from "@michaelfromyeg/weft-adapter-kit";
import { describe, expect, it } from "vitest";
import { marketplaceAdd } from "../src/marketplace";

// biome-ignore lint/suspicious/noExplicitAny: test reaches into the discriminated marketplace union.
const cliOf = (a: HarnessAdapter) => (a.harness?.marketplace as any).cli;

function stub(target: string, marketplace: unknown): HarnessAdapter {
  return {
    target,
    harness: { name: target, range: "*", marketplace },
  } as unknown as HarnessAdapter;
}

describe("adapter marketplace CLI builders", () => {
  it("claude: plugin install <name>@<mkt> and plugin marketplace add <src>", () => {
    const cli = cliOf(claudeAdapter);
    expect(cli.bin).toBe("claude");
    expect(cli.add("/src")).toEqual(["plugin", "marketplace", "add", "/src"]);
    expect(cli.install("p", "m")).toEqual(["plugin", "install", "p@m"]);
  });

  it("codex: installs via `plugin add` (not `install`)", () => {
    expect(cliOf(codexAdapter).install("p", "m")).toEqual(["plugin", "add", "p@m"]);
  });
});

describe("marketplaceAdd orchestration", () => {
  it("reports not-installed for a missing binary, manual for GUI, and skips no-marketplace harnesses", async () => {
    const adapters = [
      stub("codex", {
        cli: {
          bin: "weft-no-such-binary-xyz",
          add: (s: string) => ["go", s],
          remove: () => [],
          install: () => [],
        },
      }),
      stub("cursor", { gui: "Settings -> Plugins" }),
      // No `marketplace` field -> dropped from results entirely.
      {
        target: "opencode",
        harness: { name: "OpenCode", range: "*" },
      } as unknown as HarnessAdapter,
    ];

    const results = await marketplaceAdd(adapters, "/src");

    expect(results.map((r) => r.target).sort()).toEqual(["codex", "cursor"]);
    expect(results.find((r) => r.target === "codex")?.status).toBe("not-installed");
    const cursor = results.find((r) => r.target === "cursor");
    expect(cursor?.status).toBe("manual");
    expect(cursor?.message).toContain("Settings -> Plugins");
    expect(cursor?.message).toContain("/src");
  });

  it("strips the github: scheme so harnesses receive a bare owner/repo", async () => {
    const [r] = await marketplaceAdd([stub("cursor", { gui: "Settings" })], "github:o/r");
    expect(r.message).toContain("o/r");
    expect(r.message).not.toContain("github:");
  });
});
