import { z } from "zod";
import { Target } from "./plugin";

export const Scope = z.enum(["user", "project"]);
export type Scope = z.infer<typeof Scope>;

export const ArtifactRecord = z.object({
  /** Fully-qualified id of the plugin this artifact belongs to. */
  plugin: z.string(),
  /** Fully-qualified component id. */
  component: z.string(),
  target: Target,
  scope: Scope,
  /** Absolute placement path. */
  path: z.string(),
  /** sha256 of compiled output. */
  hash: z.string(),
  placement: z.enum(["copy", "shared"]),
  /** Executable artifacts start disabled (§11). */
  enabled: z.boolean(),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;

export const AdapterRecord = z.object({
  version: z.string(),
  targetSchema: z.string(),
  /** The harness version range this adapter's format is verified against (axis 4). */
  harnessRange: z.string().optional(),
});

/** One installed plugin's record within a lockfile. */
export const PluginLock = z.object({
  id: z.string(),
  version: z.string(),
  ref: z.string(),
  sha: z.string(),
  dependencies: z.array(
    z.object({
      id: z.string(),
      range: z.string(),
      resolvedSha: z.string(),
    }),
  ),
  /** Bare leaf name -> fully-qualified id (§9.4). */
  aliases: z.record(z.string(), z.string()),
});
export type PluginLock = z.infer<typeof PluginLock>;

/**
 * `weft.lock` — the ledger of everything installed into one target (a project for
 * project scope, the user dir for user scope). Drives update/uninstall/verify.
 * Holds many plugins so a marketplace install is a single lockfile.
 */
export const Lockfile = z.object({
  weftVersion: z.string(),
  generatedAt: z.string(),
  plugins: z.array(PluginLock),
  /** Every placed artifact across all plugins; each tagged with its `plugin` id. */
  artifacts: z.array(ArtifactRecord),
  /** Adapter version + targetSchema used per target, keyed by target name. */
  adapters: z.record(z.string(), AdapterRecord),
});
export type Lockfile = z.infer<typeof Lockfile>;
