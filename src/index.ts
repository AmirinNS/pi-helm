/**
 * pi-helm extension entry point.
 *
 * Phase 1: web tools. pi's built-ins stop at the local filesystem
 * (read, bash, edit, write, grep, find, ls), so without these the model is
 * blind to docs, errors, and anything outside the repo.
 *
 * Phase 2 (planned): autonomy levels and permission rules ported from the
 * droid model. See plans/2026-10-18-auto-permissions.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchWeb, fetchUrl, formatSearchResults, formatFetchedPage } from "./web.ts";

const WebSearchParams = Type.Object({
	query: Type.String({ description: "The search query." }),
	max_results: Type.Optional(Type.Number({ description: "Max results; default 5, hard cap 10.", minimum: 1, maximum: 10 })),
});

const FetchUrlParams = Type.Object({
	url: Type.String({ description: "The http(s) URL to fetch." }),
	max_chars: Type.Optional(Type.Number({ description: "Max characters of page text to return; default 20000.", minimum: 500, maximum: 200000 })),
});

export default function (pi: ExtensionAPI) {
	// LLM-callable: web search via SearXNG (primary) with a Brave fallback.
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for current information. Use when the answer depends on facts beyond the local repo " +
			"or training data: library and API docs, error messages, release notes, news. " +
			"Returns titles, URLs, and snippets; follow up with fetch_url to read a promising page.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const outcome = await searchWeb(params.query, { maxResults: params.max_results, signal });
			return {
				content: [{ type: "text", text: formatSearchResults(outcome) }],
				details: { engine: outcome.engine, count: outcome.results.length },
			};
		},
	});

	// LLM-callable: fetch one page and reduce it to readable text.
	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch a web page and return its readable text (scripts and markup stripped, truncated to a budget). " +
			"Use to read a URL from search results or one the user provides. " +
			"Not for authenticated or private URLs; it sends no cookies or credentials.",
		parameters: FetchUrlParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const outcome = await fetchUrl(params.url, { maxChars: params.max_chars, signal });
			return {
				content: [{ type: "text", text: formatFetchedPage(outcome) }],
				details: { finalUrl: outcome.finalUrl, truncated: outcome.truncated, chars: outcome.text.length },
			};
		},
	});
}
