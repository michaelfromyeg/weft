# Harness verification (live-docs, mid-2026)

Verified against official docs and live tools by the `harness-verify` workflow. Each
harness-specific fact must live behind that adapter's `targetSchema`, so an upstream
change is a version bump rather than a rewrite (spec §2, §8). Where a fact is `UNKNOWN`,
the driver must degrade honestly (report UNTESTED) rather than guess.

> The biggest correction to the spec: structured tool-call traces are not uniformly
> available. Claude/Codex/Cursor/OpenCode expose them only on a *specific* output
> mode, and Copilot has none from headless `-p`. `trace` assertions degrade to
> `output` assertions on harnesses without a trace (spec §14).

## Trace availability matrix

| Harness  | Headless command (trace mode)                                            | Structured trace? |
|----------|--------------------------------------------------------------------------|-------------------|
| claude   | `claude -p <prompt> --output-format stream-json --verbose`               | yes (NDJSON)      |
| codex    | `codex exec --json <prompt>`                                             | yes (JSONL)       |
| cursor   | `cursor-agent -p <prompt> --force --output-format stream-json`           | yes (NDJSON)      |
| copilot  | `copilot -p <prompt> -s` (+ `--allow-tool`/`--allow-all`)                | no -> degrade     |
| opencode | `opencode run <prompt> --format json` *or* SDK `/event` SSE              | yes (JSONL/SSE)   |

---

## Claude Code (`@anthropic-ai/claude-code`, v2.1.168) — confidence: high

- Trace: `--output-format json` is a SINGLE final result object
  (`{type:"result", result, session_id, total_cost_usd, num_turns, usage}`), not a
  trace. The tool-call trace needs `--output-format stream-json --verbose` (NDJSON).
  - Tool call = an `assistant` message content block `{type:"tool_use", id, name, input}`
    (`name` = tool name, `input` = args object).
  - Tool result = a `user` message content block `{type:"tool_result", tool_use_id, content}`.
  - `system`/`init` event lists `tools`, `mcp_servers`, `plugins[{name,path}]`, `plugin_errors[]`.
  - `--bare` = deterministic CI (skips auto-discovery; auth via `ANTHROPIC_API_KEY`).
  - Schema-constrained output: `--output-format json --json-schema '<JSONSchema>'` -> `.structured_output`.
- Plugin manifest: `.claude-plugin/plugin.json` (optional; only `name` required when present).
  Component dirs live at plugin ROOT: `skills/ commands/ agents/ hooks/ .mcp.json .lsp.json`.
  Component-path fields are relative, must start with `./`. `${CLAUDE_PLUGIN_ROOT}`,
  `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${user_config.KEY}` in hook/MCP commands.
- Marketplace: `.claude-plugin/marketplace.json` =
  `{ name, owner:{name,email?}, description?, metadata?:{pluginRoot}, plugins:[…] }`.
  Source forms (discriminator key `source`): relative `"./path"` (from marketplace root, must
  start `./`, no `..`); `{source:"github",repo,ref?,sha?}`; `{source:"url",url,ref?,sha?}`
  (git-url form); `{source:"git-subdir",url,path,ref?,sha?}`; `{source:"npm",package,version?,registry?}`.
  Plugin entry adds `category, tags, strict, displayName, defaultEnabled` + plugin.json fields.
  - `strict` defaults TRUE: plugin.json is authority, marketplace entry merges. With `strict:false`,
    the marketplace entry is the entire definition (a plugin.json declaring components is a conflict).
- Paths: user `~/.claude/{skills,agents,commands,plugins}`; project `.claude/...`;
  marketplaces in `~/.claude/plugins/known_marketplaces.json` + clones in `~/.claude/plugins/marketplaces/<name>/`.
- Validate: `claude plugin validate <dir> [--strict]` (verified locally: exit 0 on valid;
  `--strict` fails on the missing-description warning).
- Managed: `strictKnownMarketplaces` + `enabledPlugins`/`extraKnownMarketplaces` in settings.json.

## OpenAI Codex (`codex`) — confidence: high

- Trace: `codex exec --json <prompt>` -> JSONL. Events: `thread.started`, `turn.*`,
  `item.started`/`item.completed`, `error`. Tool calls inside `item` via `item.type`:
  `command_execution` (`{id,type,command,status}`), `mcp_tool_call`, `file_change`,
  `web_search`, `agent_message`, `reasoning`. The `mcp_tool_call` name/args subfields are UNKNOWN,
  so treat them as best-effort. Auto-approve: `--yolo` / `--dangerously-bypass-approvals-and-sandbox`.
  Schema: `--output-schema <file>`. Stdin: `codex exec -`.
- Skills: user `~/.agents/skills` (SHARED cross-tool path, NOT `~/.codex/skills`).
  Project `.agents/skills` (searched $CWD->parents->$REPO_ROOT). Admin `/etc/codex/skills`.
  Disable via `config.toml` `[[skills.config]]` `path=… enabled=false` (path-scoped).
- Subagents: TOML (not YAML) at `~/.codex/agents/*.toml` / `.codex/agents/*.toml`
  (fields: `name, description, developer_instructions`, opt `model, sandbox_mode, mcp_servers, skills.config`).
- `agents/openai.yaml` (per-skill sidecar) CONFIRMED fields:
  - `interface:` `{display_name, short_description, icon_small, icon_large, brand_color, default_prompt}`
  - `policy:` `{allow_implicit_invocation}` (bool, default true)
  - `dependencies:` `{tools: [{type:"mcp", value:"<server-name>"}]}`
- MCP: `~/.codex/config.toml` (or `.codex/config.toml`, trusted projects) under
  `[mcp_servers.<name>]`. stdio: `command` (req), `args`, `[mcp_servers.<name>.env]`, `cwd`.
  http: `url` (req), `bearer_token_env_var`, `http_headers`. There is no `transport` key; it is inferred
  from `command` vs `url`. Per-server: `enabled_tools`, `disabled_tools`, `tool_timeout_sec`.
- Plugins (v0.121, Apr 2026): manifest at `<plugin>/.codex-plugin/plugin.json` (`name`, opt
  `version, description, author{name,email,url}, homepage, repository, license, keywords,
  skills:"./skills/", mcpServers:"./.mcp.json", apps, hooks, interface{displayName,
  shortDescription, longDescription, developerName, category, capabilities, defaultPrompt, ...}`).
  Plugin-scoped MCP lives in a sibling `.mcp.json` -- a direct `{<name>:{command,args,env|url}}`
  map, or the wrapped `{mcp_servers:{...}}` form (NOT a plugin-local config.toml). Skills at
  `<plugin>/skills/<skill>/SKILL.md`.
- Marketplace (v0.121): catalog at `.agents/plugins/marketplace.json` (repo) or
  `~/.agents/plugins/marketplace.json` (personal). Shape: `{name, interface{displayName},
  plugins:[{name, source, policy{installation,authentication}, category}]}`. `source` is a
  discriminated object: `{source:"local", path:"./plugins/x"}` or `{source:"git-subdir", url,
  path?, ref?}` (path resolves from repo root). `policy.installation`:
  AVAILABLE|INSTALLED_BY_DEFAULT|NOT_AVAILABLE; `policy.authentication`: ON_INSTALL|ON_FIRST_USE;
  `category` required. Register a repo: `codex plugin marketplace add owner/repo` (or in-session
  `/plugin marketplace add owner/repo`). CONFIRMED against AnswerDotAI/codex-plugins + the official
  `developers.openai.com/codex/plugins/build` docs.

## Cursor (`cursor-agent`) — confidence: high

- Trace: `cursor-agent -p <prompt> --force --output-format stream-json` (NDJSON). Events:
  `system`, `user`, `assistant`, `tool_call` (subtype `started`|`completed`, with `call_id`
  and tool objects like `readToolCall`/`writeToolCall`), terminal `result`. `--output-format json`
  = single final object only (no tool events). `text` (default) = final only. `--yolo` == `--force`.
- Plugin manifest: `.cursor-plugin/plugin.json` (req `name` kebab-case; opt `description,
  version, author{name,email?}, homepage, repository, license, keywords, logo`). Component fields
  (string|array) override auto-discovery: `rules, agents, skills, commands, hooks, mcpServers`.
  Auto-discovery: `skills/ rules/ agents/ commands/ hooks/hooks.json mcp.json`. Multi-plugin:
  `.cursor-plugin/marketplace.json` (`name`, `metadata{description?,version?,pluginRoot?}`,
  `owner{name,email?}`, `plugins[]` max 500). Marketplace description nests under `metadata`
  (NOT top-level); each entry's `source` is a BARE repo-root-relative path (e.g. `plugins/x`),
  not `./`-prefixed. CONFIRMED against cursor/plugins + the team-marketplace template.
- Skills copy-as-is: Cursor loads `.claude/skills/`, `~/.claude/skills/`, `.codex/skills/`,
  `~/.codex/skills/`, `.cursor/skills/`, `~/.cursor/skills/`, `.agents/skills/`, `~/.agents/skills/`.
- Rules `.mdc` frontmatter has exactly 3 keys -> 4 modes: `alwaysApply:true`=Always;
  `globs` set + `alwaysApply:false`=Auto-Attached; `description` only=Agent-Requested;
  both omitted=Manual (@-mention). Only `.mdc` parsed in `.cursor/rules/`.
- MCP: `~/.cursor/mcp.json` (user) / `.cursor/mcp.json` (project), key `mcpServers`.
  stdio `{command,args,env}`; remote `{url,headers,auth?}`.

## GitHub Copilot CLI (`@github/copilot`) — confidence: high

- Trace: NONE from headless `copilot -p`. Only `--share <path>` (markdown transcript) /
  `--share-gist`. `--output-format`/`--json` exist ONLY on `copilot mcp` subcommands.
  So `trace` assertions must degrade to `output` for copilot. Auto-approve: `--allow-all`/`--yolo`
  or `--allow-tool='shell(git:*),write,url,mcp(<server>)'`. `-s`/`--silent` strips decoration.
- Config dir: `~/.copilot` (relocate via `COPILOT_HOME` env; there is no `--config-dir` flag).
  - skills `~/.copilot/skills/<name>/SKILL.md`; agents `~/.copilot/agents/<name>.agent.md`;
    hooks `~/.copilot/hooks/`; mcp `~/.copilot/mcp-config.json`; plugins `~/.copilot/installed-plugins/`;
    settings `~/.copilot/settings.json` (JSONC); lsp `~/.copilot/lsp-config.json`.
- Plugin manifest: `plugin.json` searched at `.plugin/plugin.json`, `plugin.json` (root),
  `.github/plugin/plugin.json`, `.claude-plugin/plugin.json` (Claude compat). Req `name` (kebab,
  ≤64). Component-path fields: `agents, skills, commands, hooks, mcpServers, lspServers`.
- Marketplace: catalog at `.github/plugin/marketplace.json` (CONFIRMED against
  github/copilot-plugins). Shape `{name, metadata{description,version?}, owner{name,email?},
  plugins:[{name, source, description?, version?, author?, keywords?, license?, repository?,
  category?, tags?}]}`. Marketplace-level description/version nest under `metadata` (NOT
  top-level). `source` is `string` (e.g. `./plugins/x`) or object `{source:"github", repo, path?}`.
- MCP: `~/.copilot/mcp-config.json`, key `mcpServers`. Per-server `type`
  (`local|stdio|http|sse`), `command`+`args`+`env` (local/stdio), `url`+`headers` (http/sse),
  `tools` (`"*"` or list). Per-session: `--additional-mcp-config <file>`.

## OpenCode (`opencode`, `@opencode-ai/sdk`) — confidence: high

- Trace: `opencode run <prompt> --format json` -> JSONL (events `step_start`, `tool_use`,
  `text`, `step_finish`, `error`; tool state collapses to `completed` only). Richest path =
  `opencode serve` (default `http://127.0.0.1:4096`) `/event` SSE via `@opencode-ai/sdk`
  (`createOpencodeClient`, `client.event.subscribe()`), with full `pending->running->completed/error`
  ToolPart `{callID, tool, state:{status,input,output,…}}`. ACP via `opencode acp` (ndjson/JSON-RPC).
  Reuse server: `opencode run … --attach http://localhost:4096`.
- Paths: user `~/.config/opencode/` with PLURAL subdirs (`skills/ agents/ commands/
  plugins/ tools/ themes/ modes/`); project `./.opencode/`. Config `~/.config/opencode/opencode.json`
  (user) / `./opencode.json` | `./.opencode.json` (project; highest precedence).
  Introspect: `opencode debug paths`, `opencode debug config`.
- No central plugin manifest; it is directory-convention. Executable plugins `.opencode/plugins/*.ts`.
- MCP: top-level `mcp` key in opencode.json. local `{type:"local", command:["npx","-y",…],
  environment:{…}, enabled, timeout}`. Note that `command` is a string ARRAY and the env key is
  `environment`, not `env`. remote `{type:"remote", url, headers, enabled, oauth, timeout}`.
  `opencode mcp add` is interactive only, so write the `mcp` block directly for headless.
  (The plugins config ARRAY key in opencode.json is `plugin` singular, though the dir is `plugins/`.)

## Official MCP Registry (federation) — confidence: high

- Now `v0.1` (the unstable `/v0/*` paths still exist). Base
  `https://registry.modelcontextprotocol.io`. OpenAPI at `/openapi.yaml`.
- `GET /v0.1/servers` — params: `cursor` (opaque), `limit` (1–100, default 30),
  `updated_since` (RFC3339), `search`, `version` (`latest`|semver), `include_deleted`.
  Response: `{ servers: [{ server: ServerJSON, _meta }], metadata: { nextCursor?, count } }`.
  Cursor-based pagination (`metadata.nextCursor`, opaque; absent on last page). Older
  write-ups citing `offset` are wrong for v0.1.
- `ServerJSON` (the inline server.json): `$schema, name, description (≤100), version`, opt
  `title, repository{url,source,id,subfolder}, packages[], remotes[], websiteUrl, icons, _meta`.
  `name` = reverse-DNS with exactly one `/` (`^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`).
  - `packages[]`: `registryType (npm|pypi|oci|nuget|mcpb), identifier, transport`, + version etc.
  - `remotes[]`: `{type: stdio|streamable-http|sse, url, headers[], variables{}}`.
- `_meta."io.modelcontextprotocol.registry/official"`: `status (active|deprecated|deleted),
  statusChangedAt, publishedAt, updatedAt, isLatest`. Use `isLatest` + `updated_since` +
  `include_deleted` for incremental sync (deletions surface as `status: deleted`).
- Ownership (do NOT reinvent): GitHub OAuth/OIDC -> `io.github.<user|org>/*`; DNS TXT
  `v=MCPv1; k=ed25519; p=<pubkey>` -> `com.example/*`; HTTP `/.well-known/mcp-registry-auth` ->
  same. `mcp-publisher login <method>` exchanges proof for a short-lived `registry_token`.

_Sources: official docs + live API per harness; full URLs in the workflow result
`tasks/weyjbun3r.output`._
