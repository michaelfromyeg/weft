import type { HarnessAdapter, HarnessMarketplaceCli } from "@michaelfromyeg/weft-adapter-kit";
import type { Target } from "@michaelfromyeg/weft-schema";
import { execa } from "execa";

/**
 * Drives each harness's NATIVE marketplace CLI from one weft command (spec §6.4):
 * `weft marketplace add <repo>` registers the repo with Claude + Codex + Copilot at
 * once, and prints the in-app steps for GUI-only harnesses (Cursor). This is the
 * consume side of a published marketplace -- distinct from `weft install`, which
 * direct-places compiled artifacts into scope dirs.
 */

export interface MarketplaceActionResult {
  target: Target;
  /** Harness display name (from the adapter). */
  name: string;
  status: "ok" | "failed" | "not-installed" | "manual";
  /** The command weft ran (cli harnesses), for display. */
  command?: string;
  /** Error output (failed) or the in-app guidance (manual). */
  message?: string;
}

async function runCli(
  target: Target,
  name: string,
  bin: string,
  args: string[],
): Promise<MarketplaceActionResult> {
  const command = [bin, ...args].join(" ");
  try {
    await execa(bin, args);
    return { target, name, status: "ok", command };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; shortMessage?: string };
    if (e.code === "ENOENT") return { target, name, status: "not-installed", command };
    const message = String(e.stderr || e.shortMessage || e.message || "").trim();
    return { target, name, status: "failed", command, message };
  }
}

/** Run one marketplace action across every adapter that declares a marketplace. */
async function dispatch(
  adapters: HarnessAdapter[],
  buildArgs: (cli: HarnessMarketplaceCli) => string[],
  manual: (gui: string) => string,
): Promise<MarketplaceActionResult[]> {
  const results: MarketplaceActionResult[] = [];
  for (const adapter of adapters) {
    const mp = adapter.harness?.marketplace;
    if (!mp) continue;
    const name = adapter.harness?.name ?? adapter.target;
    if ("gui" in mp) {
      results.push({ target: adapter.target, name, status: "manual", message: manual(mp.gui) });
    } else {
      results.push(await runCli(adapter.target, name, mp.cli.bin, buildArgs(mp.cli)));
    }
  }
  return results;
}

/**
 * Strip weft's `github:` ref scheme to the bare `owner/repo` the harness CLIs
 * accept. URLs and local paths pass through unchanged.
 */
function normalizeSource(source: string): string {
  return source.startsWith("github:") ? source.slice("github:".length) : source;
}

/** Register `source` as a marketplace with every installed harness that supports it. */
export function marketplaceAdd(
  adapters: HarnessAdapter[],
  source: string,
): Promise<MarketplaceActionResult[]> {
  const src = normalizeSource(source);
  return dispatch(
    adapters,
    (cli) => cli.add(src),
    (gui) => `register in-app -> ${gui}, pointing at ${src}`,
  );
}

/** Remove a registered marketplace by name from every harness that supports it. */
export function marketplaceRemove(
  adapters: HarnessAdapter[],
  name: string,
): Promise<MarketplaceActionResult[]> {
  return dispatch(
    adapters,
    (cli) => cli.remove(name),
    (gui) => `remove in-app -> ${gui}`,
  );
}

/** Install `plugin` from the named marketplace on every harness that supports it. */
export function marketplaceInstall(
  adapters: HarnessAdapter[],
  plugin: string,
  marketplace: string,
): Promise<MarketplaceActionResult[]> {
  return dispatch(
    adapters,
    (cli) => cli.install(plugin, marketplace),
    (gui) => `install in-app -> ${gui}`,
  );
}
