# pi-helm

The pi extension that closes the gap to droid-class coding agents. Not a fork:
everything plugs into pi's extension SDK, the same way pi-fleet does for
orchestration.

pi ships the agent loop, the TUI, sessions, and BYOK for 30+ providers. What it
leaves out on purpose (its philosophy page says so) is everything past the four
core tools. This repo adds those pieces back, one capability at a time, with
pi's token-efficiency ethos intact.

## Shipped: web tools

pi's built-in tools stop at the local filesystem (`read`, `bash`, `edit`,
`write`, `grep`, `find`, `ls`). These two close the gap:

| Tool | What it does |
| --- | --- |
| `web_search(query, max_results?)` | Searches the web. Primary engine is a self-hosted SearXNG instance over its JSON API; falls back to the Brave Search API when `BRAVE_API_KEY` is set. Returns titles, URLs, and snippets, deduped by URL, capped at 10 results, snippets truncated at 240 chars. |
| `fetch_url(url, max_chars?)` | Fetches one http(s) URL and reduces the HTML to readable text (scripts, styles, and markup stripped; entities decoded; title extracted separately). Truncates at a 20,000-char default budget and flags the truncation. Sends no cookies or credentials, so it cannot read authenticated pages. |

Configuration is by environment variable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEARXNG_URL` | `http://localhost:8888` | Base URL of the SearXNG instance. |
| `BRAVE_API_KEY` | unset | When set, Brave is the fallback if SearXNG is unreachable. |
| `PI_FLEET_FETCH_MAX_CHARS` | `20000` | Default fetch budget; the tool argument overrides it per call. |

The SearXNG instance in this workspace comes up with `docker compose up -d`
from the `recon-tools` directory. If no engine answers, `web_search` fails with
that setup hint rather than returning empty results, so the model can tell the
difference between "nothing found" and "search is not configured".

## Planned: autonomy levels and permission rules

Droid's auto permission model: four autonomy levels (off/low/medium/high)
mapped to per-command risk, plus allow/ask/block prefix rules in settings.json
with embedded match examples and a preview command. The design is in
`plans/2026-10-18-auto-permissions.md`, ported from the archived helm project
and adapted to pi's settings files and the `tool_call` extension event.

## Install and develop

```bash
npm install     # pulls the pi peer packages
npm run check   # tsc --noEmit
npm test        # node --test, all I/O stubbed
```

Load it by path (`pi -e ./src/index.ts`) for development, or symlink the repo
into `~/.pi/agent/extensions/` for auto-discovery, then `/reload`.
