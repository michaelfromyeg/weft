import type { CompileResult, Diagnostic } from "@michaelfromyeg/weft-core";
import type { CompareReport, EvalReport } from "@michaelfromyeg/weft-eval";
import { log } from "./logger";

/** Render the A/B "vibes" comparison: each case's before vs after transcript. */
export function printComparison(component: string, ref: string, reports: CompareReport[]): void {
  log.data({ component, ref, reports });
  if (reports.length === 0) {
    log.info(`\n${component}: no runnable harness to compare (all UNTESTED).`);
    return;
  }
  for (const r of reports) {
    for (const c of r.cases) {
      log.info(`\n=== ${component} :: ${c.name} [${r.harness}] ===`);
      log.info(`prompt: ${c.prompt}`);
      log.info(`\n--- before (${ref}) ---\n${c.before.trim() || "(empty)"}`);
      log.info(`\n--- after (working tree) ---\n${c.after.trim() || "(empty)"}`);
    }
  }
  log.info("\n(read the pairs and judge which definition reads better.)");
}

function formatDiagnostic(d: Diagnostic): string {
  const tag = d.severity === "error" ? "error" : d.severity === "warning" ? "warn" : "info";
  const where = d.where ? `${d.where}: ` : "";
  return `  ${tag.padEnd(5)} ${where}${d.message}`;
}

export function printDiagnostics(items: Diagnostic[]): void {
  for (const d of items) {
    const line = formatDiagnostic(d);
    if (d.severity === "error") log.error(line);
    else log.warn(line);
  }
}

/**
 * The trust summary required before first install (spec §11): what runs and on
 * whose authority. Lists components by kind, every executable artifact, every MCP
 * server, and the publisher-verification state.
 */
export function printTrustSummary(result: CompileResult): void {
  const { plugin } = result.fb;
  // Count from the components actually installed (accurate for piecemeal installs).
  const components = result.components;
  log.info(`\nTrust summary for ${result.id}@${plugin.version}`);
  log.info(`  publisher: ${plugin.owner.name} <${plugin.owner.namespace}> (unverified)`);

  const counts = new Map<string, number>();
  for (const c of components) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const summary = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  log.info(`  components: ${summary || "none"}`);

  const executables = result.targets.flatMap((t) =>
    t.artifacts
      .filter((p) => p.artifact.executable)
      .map((p) => `${t.target}:${p.artifact.relPath}`),
  );
  log.info(
    executables.length > 0
      ? `  executables (placed DISABLED): ${executables.join(", ")}`
      : "  executables: none",
  );

  log.info(`  mcp servers that will run: ${counts.get("mcp") ?? 0}`);
  log.info("  badges: valid (computed) | signed/verified/scanned: not yet\n");
}

/** Render an eval report: per-harness PASS/FAIL/UNTESTED with per-assertion status. */
export function printEvalReport(report: EvalReport): void {
  log.data(report);
  log.info(`\nEval: ${report.component}`);
  for (const h of report.harnesses) {
    if (h.status === "untested") {
      log.info(`  ${h.harness}: UNTESTED (${h.reason})`);
      continue;
    }
    log.info(`  ${h.harness}: ${h.pass ? "PASS" : "FAIL"}`);
    for (const c of h.cases) {
      log.info(`    - ${c.name}: ${c.pass ? "pass" : "fail"}`);
      for (const a of c.assertions) {
        log.info(`        ${a.kind}: ${a.status} (${a.detail})`);
      }
    }
  }
}
