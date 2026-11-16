// B5: web tools. Exercises `src/web.ts` (searchWeb, fetchUrl, formatters) with
// a stubbed fetchImpl so no test touches the network. Covers the SearXNG
// primary path, the Brave fallback, the both-engines-down error, HTML
// reduction, and the truncation budget.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	searchWeb,
	fetchUrl,
	htmlToText,
	formatSearchResults,
	formatFetchedPage,
	type FetchLike,
	type FetchLikeResponse,
} from "../src/web.ts";

interface Recorded {
	url: string;
	headers: Record<string, string>;
}

function jsonResponse(body: unknown, init: { status?: number; url?: string; contentType?: string } = {}): FetchLikeResponse {
	return {
		ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
		status: init.status ?? 200,
		url: init.url ?? "",
		headers: {
			get: (name: string) => (name.toLowerCase() === "content-type" ? init.contentType ?? "application/json" : null),
		},
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

/** Stub that records each call and replies from a queue (Error entries throw). */
function stubFetch(queue: Array<FetchLikeResponse | Error>, calls: Recorded[] = []): { fetchImpl: FetchLike; calls: Recorded[] } {
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		const next = queue.shift();
		if (next instanceof Error) throw next;
		if (!next) throw new Error("stubFetch queue exhausted");
		return next;
	};
	return { fetchImpl, calls };
}

const SEARXNG_ROWS = {
	results: [
		{ url: "https://example.com/a", title: "Result A", content: "Snippet about A.", engine: "google" },
		{ url: "https://example.com/b", title: "Result B", content: "Snippet about B.", engine: "duckduckgo" },
	],
};

test("web: searchWeb uses SearXNG by default and formats compactly", async () => {
	const { fetchImpl, calls } = stubFetch([jsonResponse(SEARXNG_ROWS)]);
	const outcome = await searchWeb("pi coding agent", { fetchImpl });

	assert.equal(outcome.engine, "searxng");
	assert.equal(outcome.results.length, 2);
	assert.equal(outcome.results[0].url, "https://example.com/a");
	assert.match(calls[0].url, /^http:\/\/localhost:8888\/search\?q=pi(%20|\+)coding(%20|\+)agent&format=json$/);
	assert.equal(calls[0].headers["Accept"], "application/json");

	const text = formatSearchResults(outcome);
	assert.match(text, /1\. Result A\n {3}https:\/\/example\.com\/a\n {3}Snippet about A\./);
});

test("web: SEARXNG_URL env overrides the default base", async () => {
	const prev = process.env.SEARXNG_URL;
	process.env.SEARXNG_URL = "http://127.0.0.1:9999/";
	try {
		const { fetchImpl, calls } = stubFetch([jsonResponse(SEARXNG_ROWS)]);
		await searchWeb("query", { fetchImpl });
		assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:9999\/search\?/);
	} finally {
		if (prev === undefined) delete process.env.SEARXNG_URL;
		else process.env.SEARXNG_URL = prev;
	}
});

test("web: snippets truncate at the cap and duplicate URLs drop", async () => {
	const rows = {
		results: [
			{ url: "https://example.com/dup", title: "Dup", content: "x".repeat(500) },
			{ url: "https://example.com/dup", title: "Dup again", content: "y".repeat(500) },
		],
	};
	const { fetchImpl } = stubFetch([jsonResponse(rows)]);
	const outcome = await searchWeb("q", { fetchImpl });

	assert.equal(outcome.results.length, 1, "duplicate URL dropped");
	assert.ok(outcome.results[0].snippet.length <= 241, `snippet capped: ${outcome.results[0].snippet.length}`);
	assert.ok(outcome.results[0].snippet.endsWith("…"), "truncated snippet ends with an ellipsis");
});

test("web: maxResults is clamped to the hard cap of 10", async () => {
	const rows = { results: Array.from({ length: 25 }, (_, i) => ({ url: `https://example.com/${i}`, title: `T${i}`, content: "s" })) };
	const { fetchImpl } = stubFetch([jsonResponse(rows)]);
	const outcome = await searchWeb("q", { maxResults: 12, fetchImpl });
	assert.equal(outcome.results.length, 10);
});

test("web: empty query is rejected before any fetch", async () => {
	const { fetchImpl, calls } = stubFetch([]);
	await assert.rejects(() => searchWeb("   ", { fetchImpl }), /non-empty query/);
	assert.equal(calls.length, 0, "no fetch attempted");
});

test("web: SearXNG down falls back to Brave when a key is set", async () => {
	const prevKey = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "test-brave-key";
	try {
		const { fetchImpl, calls } = stubFetch([
			new Error("fetch failed: ECONNREFUSED"),
			jsonResponse({ web: { results: [{ url: "https://brave.com/1", title: "Brave hit", description: "From Brave." }] } }),
		]);
		const outcome = await searchWeb("q", { fetchImpl });

		assert.equal(outcome.engine, "brave");
		assert.equal(outcome.results[0].title, "Brave hit");
		assert.equal(outcome.results[0].snippet, "From Brave.");
		assert.match(calls[1].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=q&count=5$/);
		assert.equal(calls[1].headers["X-Subscription-Token"], "test-brave-key");
	} finally {
		if (prevKey === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = prevKey;
	}
});

test("web: no engine available throws with setup hints", async () => {
	const prevKey = process.env.BRAVE_API_KEY;
	delete process.env.BRAVE_API_KEY;
	try {
		const { fetchImpl } = stubFetch([new Error("fetch failed: ECONNREFUSED")]);
		await assert.rejects(() => searchWeb("q", { fetchImpl }), /Web search failed.*SearXNG.*docker compose up -d.*BRAVE_API_KEY/s);
	} finally {
		if (prevKey !== undefined) process.env.BRAVE_API_KEY = prevKey;
	}
});

test("web: both engines failing reports both failures", async () => {
	const prevKey = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "k";
	try {
		const { fetchImpl } = stubFetch([new Error("searxng refused"), jsonResponse({}, { status: 429 })]);
		await assert.rejects(() => searchWeb("q", { fetchImpl }), /SearXNG:.*Brave: Brave Search API returned HTTP 429/s);
	} finally {
		if (prevKey === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = prevKey;
	}
});

const HTML = `<!doctype html>
<html>
<head><title>Pi &amp; Extensions</title>
<style>.hidden { color: red }</style>
<script>console.log("drop me")</script>
</head>
<body>
<h1>Guide</h1>
<p>First&nbsp;paragraph with an &lt;angle&gt; and a &quot;quote&quot;.</p>
<ul><li>One</li><li>Two</li></ul>
<div>Tail</div>
</body>
</html>`;

test("web: htmlToText strips markup, decodes entities, keeps structure", () => {
	const { title, text } = htmlToText(HTML);
	assert.equal(title, "Pi & Extensions");
	assert.ok(!text.includes("Pi & Extensions"), "title is not repeated in the body text");
	assert.ok(!text.includes("console.log"), "script content dropped");
	assert.ok(!text.includes(".hidden"), "style content dropped");
	assert.ok(!/<\/?(?:p|div|ul|li|h1|script|style|head|body|html)[\s>]/i.test(text), "no markup tags remain");
	assert.match(text, /First paragraph with an <angle> and a "quote"\./, "entities decoded, nbsp collapsed");
	assert.match(text, /\n- One\n- Two/, "list items become bullets");
	assert.ok(!/\n{3}/.test(text), "blank runs collapsed");
});

test("web: fetchUrl reduces HTML and returns short pages whole", async () => {
	const { fetchImpl, calls } = stubFetch([
		jsonResponse(HTML, { url: "https://example.com/final", contentType: "text/html; charset=utf-8" }),
	]);
	const outcome = await fetchUrl("https://example.com/page", { fetchImpl });

	assert.equal(outcome.url, "https://example.com/page");
	assert.equal(outcome.finalUrl, "https://example.com/final");
	assert.equal(outcome.title, "Pi & Extensions");
	assert.equal(outcome.truncated, false, "short page is not truncated");
	assert.match(formatFetchedPage(outcome), /# Pi & Extensions\nSource: https:\/\/example\.com\/final/);
	assert.equal(calls[0].headers["User-Agent"], "pi-fleet/1 (+web tool)");
});

test("web: fetchUrl truncates long pages at the char budget and flags it", async () => {
	const long = `<html><head><title>Long</title></head><body>${Array.from(
		{ length: 60 },
		(_, i) => `<p>Paragraph ${i} with enough words to push the document well past the budget.</p>`,
	).join("")}</body></html>`;
	const { fetchImpl } = stubFetch([jsonResponse(long, { contentType: "text/html" })]);
	const outcome = await fetchUrl("https://example.com/long", { maxChars: 500, fetchImpl });

	assert.ok(outcome.truncated, "truncation flagged");
	assert.ok(outcome.text.length <= 500, `text within budget: ${outcome.text.length}`);
	assert.match(formatFetchedPage(outcome), /\[truncated at \d+ chars\]/);
});

test("web: fetchUrl returns non-HTML bodies as-is", async () => {
	const { fetchImpl } = stubFetch([jsonResponse({ ok: true, data: [1, 2] }, { contentType: "application/json" })]);
	const outcome = await fetchUrl("https://example.com/api", { fetchImpl });
	assert.equal(outcome.title, "");
	assert.deepEqual(JSON.parse(outcome.text), { ok: true, data: [1, 2] });
	assert.equal(outcome.truncated, false);
});

test("web: fetchUrl rejects non-http schemes without fetching", async () => {
	const { fetchImpl, calls } = stubFetch([]);
	await assert.rejects(() => fetchUrl("ftp://example.com/x", { fetchImpl }), /Only http\(s\) URLs/);
	await assert.rejects(() => fetchUrl("not a url", { fetchImpl }), /Invalid URL/);
	assert.equal(calls.length, 0, "no fetch attempted");
});

test("web: fetchUrl surfaces HTTP errors", async () => {
	const { fetchImpl } = stubFetch([jsonResponse("nope", { status: 404, contentType: "text/html" })]);
	await assert.rejects(() => fetchUrl("https://example.com/missing", { fetchImpl }), /HTTP 404/);
});

test("web: formatSearchResults reports an empty result set", () => {
	assert.equal(formatSearchResults({ engine: "searxng", results: [] }), "No results.");
});
