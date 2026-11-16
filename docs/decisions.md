# Decision log

2026-10-18 | Project pivot: the from-scratch `helm` agent CLI is retired and pi-helm, a pi extension, takes over | pi ships 30+ providers with /login plus the agent loop, TUI, and sessions, so helm's milestone 1 (BYOK) was rebuilding what pi already does; the remaining value (web tools, droid-class permissions) plugs into pi's extension SDK with no fork. helm is archived at _archive/helm; its auto-permissions plan is ported here.

2026-10-18 | Repo named pi-helm | keeps the helm lineage and marks the repo as a pi extension; user pick from candidates pi-rigging, pi-bridge, pi-conn, pi-helm.

2026-10-18 | Web tools (web_search, fetch_url) moved here from pi-fleet rather than staying there | pi-fleet's charter is orchestration and cache behavior (subagents, planner/executor, guardian, compaction); web access is agent capability, not orchestration, and pi-fleet's own log already warns against growing past its validated core.

2026-10-18 | SearXNG is the primary search engine with Brave as fallback | the workspace already runs a local SearXNG instance (recon-tools docker compose; JSON API verified answering at localhost:8888), so the common path is free, private, and keyless; Brave runs only when BRAVE_API_KEY is set so there is no external dependency by default.

2026-10-18 | Web tool output is hard-capped for token efficiency: 5 results default (10 cap), 240-char snippets, 20k-char fetch budget with truncation flagged | pi's pitch is token efficiency; raw engine payloads and full page HTML are the largest avoidable context cost. The caps plus the truncation flag let the model ask for more deliberately instead of silently blowing the context window.

2026-10-18 | Toolchain mirrors pi-fleet: tsc --noEmit plus node --test --experimental-strip-types, no vitest | the web code moved as-is from pi-fleet, and the two sibling extensions then share one test idiom; a vitest setup would add a second runner for no gain.

2026-10-18 | Web tools fail loudly with setup hints instead of returning empty results | an empty result set and a misconfigured engine are different facts; the model must be able to tell "nothing found" from "search is not set up", so the error names the fix (docker compose up -d from recon-tools, SEARXNG_URL, or BRAVE_API_KEY).
