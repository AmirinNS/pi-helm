# Plan: Auto permissions (autonomy levels and permission rules)

> Ported from the archived `helm` project (`_archive/helm`), where this plan
> targeted a from-scratch agent CLI. Adapted here for pi: settings live in pi's
> own `settings.json` (no new config files), enforcement is the `tool_call`
> extension event, and the preview command is a pi command, not a CLI binary.
> The engine design (risk levels, rule matching, decision order) is unchanged.

## Goal

helm gets droid's auto permission system: an autonomy level (off, low, medium,
high) that decides which tool calls run without approval, and permission rules
that allow, ask, or block shell commands by exact command prefix. A user can
raise autonomy for a session with `--auto`, and inspect any decision with
`/rules check` before a command ever runs.

This plan ships the policy engine, its settings schema, and the `/rules check`
command. The approval prompt itself is the TUI's `ctx.ui.confirm`, which the
extension already has access to.

## Scope

- In scope:
  - autonomy levels off/low/medium/high and a risk level (low/medium/high) for
    built-in tools and shell commands
  - permission rules with `allow`, `ask`, and `block` decisions, exact ordered
    prefix matching with nested alternatives, and embedded match/noMatch
    examples that must pass for a rule to go active
  - rule sources: pi's global settings (`~/.pi/agent/settings.json`) and
    project settings (`.pi/settings.json`, loaded after project trust), with
    pi's existing nested-merge semantics
  - decision order: matching block beats ask beats allow, no match falls back
    to risk versus autonomy, unparseable shell asks
  - a `/rules check` command with `--command`, `--file`, and `--json`
  - an `--auto <level>` extension flag overriding the configured default for
    the session, and `--skip-permissions-unsafe`
- Out of scope:
  - organization-level managed policy and folder-nested rule files (single user)
  - OS-level sandboxing, hooks, and secret scanning (separate plans)
  - legacy command allowlist/denylist/blocklist migration (greenfield)
  - subagent autonomy inheritance (pi-fleet owns subagents; coordinate if the
    `task` tool later needs its own level)

## Approach

### Milestone 1: Autonomy levels and risk model

1. Write `src/permissions/types.ts`: `AutonomyLevel` (`"off" | "low" |
   "medium" | "high"`) and `RiskLevel` (`"low" | "medium" | "high"`) unions,
   ordered rank arrays, and a `Decision` union (`"allow" | "ask" | "block"`).
2. Write `src/permissions/risk.ts` with `toolRisk(toolName)` and
   `classifyCommand(argv)`:
   - low: `ls`, `pwd`, `cat`, `head`, `tail`, `rg`, `find`, `git status`,
     `git log`, `git diff`, `git show`, `git branch` (list form)
   - medium: `mkdir`, `touch`, `cp`, `mv`, `npm install`, `npm run`,
     `npm test`, `git add`, `git commit`
   - high: `git push`, `git reset`, `docker`, `rm -rf`, `curl`, `wget`,
     package publish, and any command not in the table
3. Write `src/permissions/safeguards.ts`: a short list of destructive forms
   (`rm -rf /`, `rm -rf ~`, `git push --force`, `dd`, `mkfs`) that escalate to
   ask even when a rule allows the prefix. Keep the list small and testable.
4. Write `test/risk.test.ts`: table-driven cases for `classifyCommand`,
   `toolRisk`, and the safeguard escalation.
   → Verify: `npm test` passes.

### Milestone 2: Rule schema, prefix matching, embedded tests

1. Write `src/permissions/rules.ts`: the container type
   `{ version: 1, rules: Rule[] }`, the `Rule` type (`id`, `decision`,
   `match.prefix`, `tests.match`, `tests.noMatch`, optional `reason` and
   `enabled`), `validateRules(raw)` returning valid rules plus per-rule
   errors, and `runRuleTests(rule)` executing the embedded examples.
2. Write `src/permissions/shell.ts`: `tokenize(command)` honoring single and
   double quotes and returning null on forms helm will not judge (redirects,
   expansions, command substitution), and `splitSegments(command)` splitting
   on `&&`, `||`, `;`, and `|`.
3. Write `matchesPrefix(prefix, argv)` in `src/permissions/rules.ts`: exact,
   case-sensitive token comparison in order, trailing arguments allowed, and
   nested arrays supplying alternatives at one position.
4. Write `test/rules.test.ts`: the documented cases (`git status` and
   `git "status"` match `["git", "status"]`; `git statusx`, `GIT status`,
   `git -C /repo status`, and `/usr/bin/git status` do not), nested
   alternatives, tokenizer quoting and null cases, and rules whose examples
   fail being rejected by `validateRules`.
   → Verify: `npm test` passes.

### Milestone 3: Settings source and the decision engine

1. Verify against the installed pi version how an extension reads resolved
   settings (the SDK's `SettingsManager`, the same path
   `createAgentSession()` uses). Confirm project settings are only visible
   after project trust; untrusted projects see global rules only.
2. Write `src/permissions/sources.ts`: `loadRules(settings)` collecting rules
   from the `permissions.rules` key of the resolved settings. Resolve repeated
   IDs by source priority (project shadows global); a valid disabled rule still
   claims its ID. Skip a whole source on a malformed container.
3. Write `src/permissions/engine.ts`: `createPolicy({ rules, autonomyLevel,
   skipPermissions })` returning `decide({ tool, argv })`:
   - evaluate every matching rule across all command segments; block wins,
     then ask, then allow
   - no match: allow when the classified risk ranks at or below the autonomy
     level, otherwise ask
   - unparseable command forms ask
   - with `skipPermissions` on, ask results become allow but block results
     stay block
   - every decision carries the winning rule id and reason when a rule matched
4. Write `test/engine.test.ts`: block-beats-allow across sources, same-ID
   shadowing, autonomy fallback for each level, a chain where one segment is
   blocked, unparseable input asking, and `skipPermissions` keeping blocks.
   → Verify: `npm test` passes.

### Milestone 4: `/rules check` command

1. Write `src/commands/rules.ts` registering `/rules check` via
   `pi.registerCommand`:
   - no arguments validates the resolved rules and prints per-rule pass or
     fail with the failing examples
   - `--command '<cmd>'` previews the effective decision (`allow`, `ask`,
     `block`, or `no-match`) with the rule id, reason, and source
   - `--file <path>` validates a standalone `{version, rules}` object or a
     bare rule array without loading settings
   - `--json` prints the same report machine-readable
   - the command reports success even when the previewed decision is block;
     invalid rules or failing examples are reported as failures
2. Write `test/rules-cli.test.ts` driving the command handler with a stubbed
   `ctx` (notify capture, temp settings dir): valid rules pass, a failing
   example fails, and `--command 'git push origin main'` reports the expected
   decision.
   → Verify: `npm test` passes and a manual `/rules check --command 'git
   push'` runs in a live session.

### Milestone 5: Session wiring and enforcement

1. Extend settings handling to accept `permissions.autonomyLevel` and
   `permissions.rules`, rejecting an unknown autonomy level with an error
   naming the valid values.
2. Register the `--auto <level>` extension flag overriding the configured
   default for the session, and `--skip-permissions-unsafe`.
3. Wire enforcement in `pi.on("tool_call")`:
   - `block` returns `{ block: true, reason }`
   - `allow` returns nothing
   - `ask` calls `ctx.ui.confirm(...)` when a UI exists; in print and RPC modes
     (`hasUI` false) ask resolves to block unless `--auto` raised the level,
     which keeps headless runs fail-closed
4. Write the auto permissions section in `README.md`: the four levels, the rule
   JSON shape with one allow and one block example, source precedence, and
   `/rules check` usage.
5. Append the decisions to `docs/decisions.md`.
   → Verify: `npm run check && npm test` green and README examples match the
   command's actual output.

## UI / Design

- Prototype: not needed. The approval surface is pi's existing `ctx.ui.confirm`
  and the status line; no new screens.

## Affected Files

- Files to modify: `src/index.ts`, `README.md`, `docs/decisions.md`.
- New files to create: `src/permissions/types.ts`,
  `src/permissions/risk.ts`, `src/permissions/safeguards.ts`,
  `src/permissions/rules.ts`, `src/permissions/shell.ts`,
  `src/permissions/sources.ts`, `src/permissions/engine.ts`,
  `src/commands/rules.ts`, `test/risk.test.ts`, `test/rules.test.ts`,
  `test/engine.test.ts`, `test/rules-cli.test.ts`.

## Acceptance Criteria

- [ ] At autonomy off, a low-risk command runs and a medium-risk command asks.
- [ ] At autonomy medium, installs, builds, and local commits run while
      `git push` asks.
- [ ] An allow rule lets a matching command run even above its risk level.
- [ ] An ask rule requires approval even at high autonomy.
- [ ] A block rule rejects the command with no approval path, including under
      `--skip-permissions-unsafe`.
- [ ] A block in project settings beats an allow in global settings.
- [ ] The same rule ID in project settings shadows the global definition.
- [ ] A rule whose embedded examples fail is skipped and reported by
      `/rules check`.
- [ ] `/rules check --command 'git push origin main'` reports the decision,
      rule id, and source.
- [ ] An unparseable command form asks rather than runs.
- [ ] In `-p` mode, an ask decision blocks the command (fail-closed) unless
      the level was raised.
- [ ] `npm run check && npm test` pass.

## Tests

- Test type: unit plus command-level integration (stubbed `ctx` and settings,
  no network).
- Tests to run: `npm test`, `npm run check`.
- Tests to add: `test/risk.test.ts`, `test/rules.test.ts`,
  `test/engine.test.ts`, `test/rules-cli.test.ts`.
- Test file location: `test/` at repo root.

## Dependencies

- Libraries to add: none. Matching, tokenizing, and the engine are plain
  TypeScript; the command uses the extension SDK pi already provides.
- External services: none.

## Decisions Log

| Decision | Chosen | Alternatives Considered | Why |
|----------|--------|------------------------|-----|
| Autonomy model | four levels off/low/medium/high with per-tool risk levels | single allow/ask toggle, per-tool allowlists only | mirrors droid so the mental model transfers; a toggle cannot express "edits yes, pushes no" |
| Rule decisions | allow, ask, block | allow/deny only | block is a hard stop with no approval path, which deny in a two-value model cannot express |
| Prefix matching | exact ordered tokens with nested alternatives | regex, glob, substring | matches droid; predictable, and `*` stays a literal token instead of a surprise wildcard |
| Embedded tests | required `tests.match` and `tests.noMatch` on every rule | optional tests, no tests | a rule that cannot state what it matches is a bug waiting to ship; droid requires them |
| Settings location | pi's existing `settings.json` under a `permissions` key | new config file, new config dir | pi already merges global and project settings with trust gating; a second config system would diverge |
| Same-ID conflicts | higher-priority source shadows lower before matching | last-writer-wins, merge | mirrors droid's two-stage resolution and keeps one ID meaning one thing |
| Cross-ID precedence | block beats ask beats allow | first-match-wins, source-order-wins | mirrors droid; a global allow must not defeat a project block |
| Unknown commands | classified high risk, so they ask below high autonomy | classified low, classified medium | an unrecognized command is the dangerous case; defaulting it to ask is the safe failure |
| Unparseable shell | decision is ask | decision is allow, decision is block | pi will not judge redirects and substitutions, so it must not run them silently; block would remove the user's ability to approve |
| Ask in headless | ask resolves to block in `-p` and RPC modes | ask resolves to allow, refuse to run headless | headless runs are automation; a prompt that cannot be shown must fail closed, and `--auto` is the documented opt-up |
| Enforcement point | `pi.on("tool_call")` with block/confirm | wrap the built-in tools, fork pi | the event is the documented seam and covers extension tools too |
| Skip flag | `--skip-permissions-unsafe`, blocks still apply | `--yes`, `--force` | mirrors droid's name and semantics; the unsafe suffix keeps the risk visible in history |
| Legacy lists | none, greenfield | port commandAllowlist/denylist/blocklist | pi has no prior settings to stay compatible with |
| Org controls | none | maxAutonomyLevel, managed org rules | single user; an org cap has nothing to cap |
