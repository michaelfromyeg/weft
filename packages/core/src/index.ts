export type {
  BuildMarketplaceOptions,
  BuildMarketplaceResult,
  BuildOptions,
  BuildResult,
  InstallMarketplaceOptions,
  InstallMarketplaceResult,
  InstallOptions,
  InstallResult,
  LintResult,
  PluginInstall,
  UninstallOptions,
  UninstallResult,
  UpdateResult,
} from "./api";
export {
  build,
  buildMarketplace,
  install,
  installMarketplace,
  lint,
  uninstall,
  update,
} from "./api";
export type {
  CompileOptions,
  CompileResult,
  ResolvedComponent,
  StaticPass,
  TaggedArtifact,
  TargetOutput,
} from "./compile";
export { compile, staticPass, synthMarketplace } from "./compile";
export type { ConfigResolution, SecretsResult } from "./config";
export { resolveConfig } from "./config";
export type { DependencyRecord, ResolvedDeps } from "./deps";
export { resolveDependencies } from "./deps";
export type { Diagnostic, Severity } from "./diagnostics";
export { CompileError, Diagnostics } from "./diagnostics";
export type { HarnessCheck } from "./harness";
export { checkHarness, checkHarnesses, detectHarnessVersion } from "./harness";
export { sha256 } from "./hash";
export type { ImportOutput, ImportPluginOptions } from "./import";
export { importNativePlugin } from "./import";
export type { FetchedMarketplace, FetchedPlugin } from "./loader";
export { fileAccessors, hasMarketplaceManifest, loadMarketplaceDir, loadPluginDir } from "./loader";
export type { LockEntry, LockEntryInput } from "./lockfile";
export {
  buildLockEntry,
  lockDirForScope,
  mergeLock,
  readLock,
  serializeLock,
  writeLock,
} from "./lockfile";
export type { ManagedPolicy, PolicyContext } from "./managed";
export { checkManagedPolicy } from "./managed";
export type { MarketplaceActionResult } from "./marketplace";
export { marketplaceAdd, marketplaceInstall, marketplaceRemove } from "./marketplace";
export type { AliasInput, AliasResult } from "./namespace";
export { resolveAliases } from "./namespace";
export type { DriftReport, PlannedArtifact, PlannedWrite, WrittenArtifact } from "./place";
export {
  buildToDir,
  dedupePlanned,
  diffPlanned,
  findPlanConflicts,
  installToScope,
  placeCatalog,
  placePluginArtifacts,
  planBuild,
  planCatalog,
  planPluginArtifacts,
  planScopeArtifacts,
  writePlanned,
} from "./place";
export { AdapterRegistry } from "./registry";
export type { ResolvedPlugin, ResolvedSource, Source } from "./resolve";
export {
  CACHE_DIR,
  gitInfo,
  parseSource,
  resolveDependency,
  resolvePluginRef,
  resolvePluginRefFull,
  resolveSourceDir,
} from "./resolve";
export type { VerifyResult } from "./sign";
export {
  artifactDigest,
  generateSigningKeys,
  signLock,
  verifyArtifacts,
  verifyLockSignature,
} from "./sign";
export { validatePlugin } from "./validate";
export { checkMinVersion, WEFT_VERSION } from "./version";
