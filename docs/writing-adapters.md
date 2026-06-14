# Writing an adapter

A harness adapter is the "compiler backend" that turns canonical components into one
harness's native plugin format. It is a plain object implementing `HarnessAdapter` from
`@michaelfromyeg/weft-adapter-kit`, and it depends only on `@michaelfromyeg/weft-adapter-kit` and `@michaelfromyeg/weft-schema`, never
on core internals. The consumer (the CLI, or an embedding app) registers it.

## The contract

```ts
import type { HarnessAdapter } from "@michaelfromyeg/weft-adapter-kit";

export const myAdapter: HarnessAdapter = {
  target: "myharness",            // must be a known Target (extend @michaelfromyeg/weft-schema's enum)
  version: "0.1.0",               // this adapter package's version (lockfile axis 3)
  targetSchema: "myharness/1.0",  // the harness manifest schema version you emit
  harness: {                      // optional: upstream harness CLI + supported range (axis 4)
    name: "My Harness",
    versionCommand: "myharness --version",
    range: ">=1.0.0 <2.0.0",      // the harness version range your emitted format is verified against
  },

  detect(scope, cwd) { /* InstallPaths for user|project */ },
  transform(component, ctx) { /* one component -> native artifacts */ },
  emitManifest(plugin, ctx) { /* plugin-level manifest, or [] */ },
  emitCatalog(marketplace) { /* native catalog from a ResolvedMarketplace */ },

  driver: { /* optional: headless eval support */ },
};
```

### `targetSchema` is the churn firewall

Put every harness-specific fact behind this adapter, including manifest field names, file
locations, and headless flags, and bump `targetSchema` when the harness changes its format.
That way an upstream change is a version bump in one package, not a change to any plugin.
The verified facts to encode are in [docs/harness-research.md](harness-research.md).

### `CompiledArtifact`

```ts
interface CompiledArtifact {
  relPath: string;            // relative to the native plugin/output root
  contents: string | Buffer;
  kind?: ArtifactKind;        // "skill" | "mcp" | ... for the trust summary + lockfile
  executable?: boolean;       // passthrough; core places it DISABLED
}
```

`relPath` is plugin-root-relative (e.g. `skills/code-review/SKILL.md`,
`.claude-plugin/plugin.json`). Core decides the absolute base per build mode and scope, so
your adapter never hard-codes absolute paths.

### `PluginCtx`

Passed to every adapter call:

```ts
interface PluginCtx {
  plugin: Plugin;
  read(relPath: string): Buffer;     // read a plugin file (store standards verbatim)
  list(relDir: string): string[];    // recursively list files under a plugin dir
  aliasFor(componentId: string): string;  // bare alias, or the fqid on collision
}
```

Use `list` + `read` to copy a component directory verbatim; use `read` to parse a
`server.json` and derive the harness's runnable MCP config.

## Two emission modes

- transform is called once per component. Return its native files.
- emitManifest is called once per plugin. Return the plugin-level manifest (e.g.
  Claude's `plugin.json`), aggregating across components where needed, such as collecting
  every MCP server into one inline `mcpServers` block. Return `[]` for
  directory-convention harnesses (like OpenCode) that need no manifest.
- emitCatalog turns a `ResolvedMarketplace` (every entry already resolved to concrete
  name/description/version by core) into the harness's native catalog.

## Headless eval (optional)

Provide a `driver` only if the harness has a headless mode that exposes a usable result:

```ts
interface HarnessDriver {
  readonly target: Target;
  available(): Promise<boolean>;   // CLI installed AND headless-capable; never throws
  run(opts): Promise<Transcript>;  // normalize stdout into { finalText, toolCalls, ... }
}
```

If the harness exposes no structured tool-call trace, set `traceUnavailable: true` on the
`Transcript`; the eval runner degrades `trace` assertions to `output` assertions and
reports the harness honestly rather than faking a pass.

## Registering it

```ts
import { AdapterRegistry } from "@michaelfromyeg/weft-core";
import { myAdapter } from "@michaelfromyeg/weft-adapter-myharness";

const registry = new AdapterRegistry().register(myAdapter);
```

Publish it as an npm package; anyone can register it without forking Weft.
