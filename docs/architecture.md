# Architecture

Weft is a compiler, not a platform. The primary artifact is an importable library
(`@michaelfromyeg/weft-core`) with a thin CLI on top. Everything tool-specific lives behind a versioned
adapter, so an upstream manifest change touches one adapter, not your plugins.

## Packages and dependency direction

```
schema  <-  core  <-  (adapter-*, eval, index)  <-  cli
                ^
          adapter-kit  (the public contract adapters implement)
```

- `@michaelfromyeg/weft-schema` is the canonical data model. It holds Zod schemas for `weft.yaml`,
  `marketplace.yaml`, `weft.lock`, and `cases.yaml`; inferred types; a JSON-Schema export
  for editor autocomplete; and the YAML-1.2 / JSON5 parse path.
- `@michaelfromyeg/weft-adapter-kit` is the `HarnessAdapter` and `HarnessDriver` interfaces plus
  shared helpers (frontmatter, paths, artifact builder). A community adapter depends only
  on this + `@michaelfromyeg/weft-schema`.
- `@michaelfromyeg/weft-core` is the compile pipeline, the adapter registry, namespacing/aliases,
  placement (build vs install), and the lockfile.
- `@michaelfromyeg/weft-adapter-*` is one package per harness. Each implements `HarnessAdapter`.
- `@michaelfromyeg/weft-cli` sits at the top of the graph and wires concrete adapters into a
  registry. Core never imports a concrete adapter, which keeps the dependency direction
  one-way and lets community adapters slot in.

## The compile pipeline (`@michaelfromyeg/weft-core`)

`compile(fetchedPlugin, { registry, targets })` runs the canonical-to-native transform
(spec §9.1). Placement and the lockfile are deliberately separate so `build` can produce
inspectable output without touching any harness install directory.

1. Load and validate. `weft.yaml` is parsed (YAML 1.2-strict | JSON5) and validated by
   Zod with path-precise errors. `weft_min_version` is enforced.
2. Static validation (`staticPass`) confirms that referenced files exist, skill/agent
   frontmatter is well-formed, `server.json` parses, and descriptions clear a quality bar.
   This is the deterministic "is this plugin valid?" pass behind the valid badge.
3. Namespace and alias resolution. Each component gets a fully-qualified id
   `{namespace}/{plugin}:{leaf}`; a leaf used by exactly one component earns the bare
   alias, and a shared leaf surfaces as a collision (never silent last-wins).
4. Transform. For each `(component x target)`, the adapter's `transform` produces
   native artifacts; `emitManifest` produces the plugin-level manifest (e.g. Claude
   `plugin.json`); `emitCatalog` produces the marketplace catalog.
5. Place. `build` writes `outDir/<target>/` in marketplace+plugin layout; `install`
   copies the plugin tree into the scope's dirs and records every file.
6. Lockfile. `install` writes `weft.lock` with content hashes, scope/paths, adapter
   and target-schema versions, and the alias table.

Diagnostics are accumulated, not thrown, so the caller can render every problem at once;
`build`/`install` fail closed when any error is present.

## The adapter seam

```ts
interface HarnessAdapter {
  readonly target: Target;
  readonly version: string;       // adapter package version (versioning axis 3)
  readonly targetSchema: string;  // the harness manifest schema version it emits
  readonly harness?: HarnessCompat;  // upstream harness CLI + supported range (axis 4)
  detect(scope, cwd): InstallPaths;
  transform(component, ctx): CompiledArtifact[];
  emitManifest(plugin, ctx): CompiledArtifact[];
  emitCatalog(marketplace): CompiledArtifact[];   // marketplace is fully resolved
  driver?: HarnessDriver;         // present iff headless eval is supported
}
```

Every harness-specific fact (manifest field names, install paths, headless flags) lives
behind `targetSchema`. When an upstream tool changes its format, that is a new adapter
release with a bumped `targetSchema`, and plugins are untouched. See
[docs/harness-research.md](harness-research.md) for the verified per-harness facts.

## Versioning (four independent axes)

All four are recorded in `weft.lock` (spec §5):

1. Plugin version: semver, git-tag to resolved SHA.
2. Weft/CLI version: plugins declare `weft_min_version`.
3. Adapter <-> target-schema version: each adapter declares the harness schema it emits.
4. Harness CLI version: each adapter declares a `harness` range its emitted format is
   verified against. `weft build` detects the installed harness version (or takes
   `--harness <target>@<version>`) and warns when it falls outside that range -- the early
   signal that an upstream release may have moved the format past what the adapter emits.

Content-addressed artifact hashes make "is there really a new version?" exact: `weft
update` re-resolves, recompiles, diffs hashes, and re-places only what changed.

## Why these boundaries

- Single source of truth. The author writes the plugin once; all tool-specific output
  is generated, never hand-maintained. No command ever asks you to edit a generated file.
- Standards as inputs. `SKILL.md` and `server.json` are stored verbatim in the plugin;
  the adapter is the only place that knows a harness's shape.
- Deep modules. `compile` does a lot behind a small interface; adapters hide a harness's
  full manifest complexity behind four methods.
