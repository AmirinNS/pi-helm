# AGENTS.md — pi-helm

Guidance for AI agents working in this project. `CLAUDE.md` symlinks here.

## What this is

A **pi extension** (TypeScript) that adds the droid-class and opencode-class
capabilities pi deliberately leaves out. It is the successor to the archived
`helm` project (see `_archive/helm`), which tried to build a complete agent
from scratch before pi's own surface made that redundant.

The division of labor in this workspace:

| Repo | Owns |
|------|------|
| pi (upstream) | agent loop, TUI, sessions, 30+ provider BYOK |
| pi-fleet | orchestration: subagents, planner/executor, guardian, compaction |
| pi-helm (this repo) | agent capability: web tools now, permissions next |

## Non-negotiable design rules

1. **No fork of pi.** Everything integrates through the public extension SDK
   (`@earendil-works/pi-coding-agent`). If a feature seems to need a pi source
   change, stop and reconsider.
2. **Model-agnostic.** Features must never branch on the model or provider.
3. **Token-efficient outputs.** Every tool caps what it returns and flags
   truncation. Raw engine payloads and full HTML never reach the model.
4. **Settings live in pi's settings.json** (`~/.pi/agent/settings.json` global,
   `.pi/settings.json` project). No new config files, no new config dirs.
5. **Every tool is tested with stubbed I/O.** No test touches the network.
   External calls go through an injectable `fetchImpl` seam.

## Commands

- `npm run check` — `tsc --noEmit` (mirrors pi-fleet's toolchain)
- `npm test` — `node --test --experimental-strip-types` over `test/`

The three `@earendil-works/pi-*` packages are `peerDependencies`; npm
auto-installs them so `npm run check` resolves the extension types.

## Plans

`plans/` holds one plan per shippable slice, same convention as pi-fleet.
The active roadmap is `plans/2026-10-18-auto-permissions.md` (ported from
helm, adapted to pi's settings and extension API).

Log non-trivial choices with the `log-decision` skill into
`docs/decisions.md`. The format there is `date | decision | rationale`.
