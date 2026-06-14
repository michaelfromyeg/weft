import type { Component, Plugin, Scope, Target } from "@michaelfromyeg/weft-schema";
import type { CompiledArtifact } from "./artifact";
import type { ResolvedMarketplace } from "./catalog";
import type { HarnessDriver } from "./driver";
import type { ImportOptions, ImportResult } from "./import";
import type { InstallPaths } from "./paths";

/**
 * Read-only view of the fetched plugin passed to every adapter call. `read`
 * returns file bytes from the plugin so adapters can store standards verbatim;
 * `aliasFor` resolves a component's bare invocation name (spec §9.4).
 */
export interface PluginCtx {
  plugin: Plugin;
  read(relPath: string): Buffer;
  /** Recursively list files under a plugin directory, as paths relative to the plugin root. */
  list(relDir: string): string[];
  aliasFor(componentId: string): string;
}

/**
 * Declares the upstream harness CLI this adapter targets and the version RANGE
 * its emitted format is verified against (versioning axis 4, spec §5). Where
 * `targetSchema` is Weft's INTERNAL tag for the format it emits, this is the
 * EXTERNAL tool the format must satisfy. `weft build` detects the installed
 * harness version (or uses one the caller declares) and warns when it falls
 * outside `range` -- the early signal that an upstream release may have moved
 * the format past what this adapter emits. Optional: omit when the harness has
 * no version-printing CLI to compare against.
 */
export interface HarnessCompat {
  /** Human-facing harness name for messages (e.g. "Codex CLI"). */
  readonly name: string;
  /** Shell command that prints the installed version (e.g. "codex --version"). */
  readonly versionCommand?: string;
  /** Semver range the emitted format is known-good for (e.g. ">=0.121.0 <0.130.0"). */
  readonly range: string;
}

/**
 * The seam between Weft's canonical model and one harness's native format
 * (spec §7). Every harness-specific fact lives behind `targetSchema`, so an
 * upstream schema change is a version bump here, not a change to any plugin.
 *
 * A community adapter implements this interface and is registered by its consumer
 * (the CLI or an embedding app) -- it depends only on @michaelfromyeg/weft-adapter-kit + @michaelfromyeg/weft-schema.
 */
export interface HarnessAdapter {
  readonly target: Target;
  /** This adapter package's own version (versioning axis 3, spec §5). */
  readonly version: string;
  /** The harness manifest schema version this adapter emits against. */
  readonly targetSchema: string;
  /** The upstream harness CLI + supported version range (versioning axis 4). */
  readonly harness?: HarnessCompat;

  /**
   * Place artifacts directly under the scope's category dirs without the
   * `plugins/<name>/` grouping. For directory-convention harnesses that load
   * skills flatly from `.agents/skills/<leaf>/` rather than per-plugin.
   */
  readonly flat?: boolean;

  /** Resolve install directories for a scope on this machine. */
  detect(scope: Scope, cwd: string): InstallPaths;

  /** Compile one canonical component to its native artifacts. */
  transform(component: Component, ctx: PluginCtx): CompiledArtifact[];

  /**
   * Emit the plugin-level native manifest(s) (e.g. Claude `plugin.json`).
   * Returns `[]` for directory-convention harnesses that need none.
   */
  emitManifest(plugin: Plugin, ctx: PluginCtx): CompiledArtifact[];

  /**
   * Emit the harness's native marketplace catalog from a fully-resolved
   * marketplace. Used for both a curated `marketplace.yaml` (many plugins) and
   * the single-plugin build (a synthetic one-entry marketplace).
   */
  emitCatalog(marketplace: ResolvedMarketplace): CompiledArtifact[];

  /** Present iff headless eval is supported on this harness. */
  driver?: HarnessDriver;

  /**
   * Reverse-compile an existing native plugin or marketplace in `dir` into the
   * canonical Weft model, so it can be cross-compiled to the other harnesses
   * ("federate, don't wall off" applied to assets you already maintain). Returns
   * null when `dir` is not this harness's format. Present iff the harness supports it.
   */
  importNative?(dir: string, opts?: ImportOptions): ImportResult | null;
}
