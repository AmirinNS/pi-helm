/**
 * Web tools for pi: `web_search` and `fetch_url`.
 *
 * Search runs against a self-hosted SearXNG instance's JSON API (primary) and
 * falls back to the Brave Search API when `BRAVE_API_KEY` is set. Fetch pulls a
 * single http(s) URL and reduces the HTML to readable text.
 *
 * Both paths take an injectable `fetchImpl` so tests never touch the network,
 * and both are shaped for token efficiency: capped result counts, truncated
 * snippets, and no boilerplate in the returned text.
 */

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchOutcome {
	engine: string;
	results: SearchResult[];
}

export interface FetchOutcome {
	url: string;
	finalUrl: string;
	title: string;
	text: string;
	truncated: boolean;
}

/** Minimal structural stand-in for the parts of `Response` these tools use. */
export interface FetchLikeResponse {
	ok: boolean;
	status: number;
	url: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export type FetchLike = (
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface SearchOptions {
	maxResults?: number;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
}

export interface FetchOptions {
	maxChars?: number;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
}

const SEARXNG_DEFAULT = "http://localhost:8888";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const SNIPPET_MAX = 240;
const RESULTS_DEFAULT = 5;
const RESULTS_CAP = 10;
const FETCH_CHARS_DEFAULT = 20000;
const FETCH_CHARS_MIN = 500;
const FETCH_CHARS_MAX = 200000;
const SEARCH_TIMEOUT_MS = 20000;
const FETCH_TIMEOUT_MS = 30000;
const USER_AGENT = "pi-fleet/1 (+web tool)";

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function truncate(s: string, max: number): string {
	const t = s.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function signalOrTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal ?? AbortSignal.timeout(ms);
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	const out: SearchResult[] = [];
	for (const r of results) {
		if (!r.url || seen.has(r.url)) continue;
		seen.add(r.url);
		out.push(r);
	}
	return out;
}

// --- search -----------------------------------------------------------------

async function searxngSearch(
	query: string,
	maxResults: number,
	fetchImpl: FetchLike,
	signal: AbortSignal | undefined,
): Promise<SearchOutcome> {
	const base = (process.env.SEARXNG_URL ?? SEARXNG_DEFAULT).replace(/\/+$/, "");
	const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
	const res = await fetchImpl(url, {
		headers: { Accept: "application/json", "User-Agent": USER_AGENT },
		signal: signalOrTimeout(signal, SEARCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`SearXNG at ${base} returned HTTP ${res.status}`);
	const data = JSON.parse(await res.text()) as { results?: unknown };
	const rows = Array.isArray(data?.results) ? data.results : [];
	const results: SearchResult[] = [];
	for (const row of rows) {
		const r = (row ?? {}) as Record<string, unknown>;
		const link = typeof r.url === "string" ? r.url : "";
		if (!link) continue;
		results.push({
			title: truncate(typeof r.title === "string" ? r.title : link, 160),
			url: link,
			snippet: truncate(typeof r.content === "string" ? r.content : "", SNIPPET_MAX),
		});
		if (results.length >= maxResults) break;
	}
	return { engine: "searxng", results: dedupeByUrl(results) };
}

async function braveSearch(
	query: string,
	maxResults: number,
	fetchImpl: FetchLike,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<SearchOutcome> {
	const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${maxResults}`;
	const res = await fetchImpl(url, {
		headers: { Accept: "application/json", "X-Subscription-Token": apiKey, "User-Agent": USER_AGENT },
		signal: signalOrTimeout(signal, SEARCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`Brave Search API returned HTTP ${res.status}`);
	const data = JSON.parse(await res.text()) as { web?: { results?: unknown } };
	const rows = Array.isArray(data?.web?.results) ? data.web.results : [];
	const results: SearchResult[] = [];
	for (const row of rows) {
		const r = (row ?? {}) as Record<string, unknown>;
		const link = typeof r.url === "string" ? r.url : "";
		if (!link) continue;
		results.push({
			title: truncate(typeof r.title === "string" ? r.title : link, 160),
			url: link,
			snippet: truncate(typeof r.description === "string" ? r.description : "", SNIPPET_MAX),
		});
		if (results.length >= maxResults) break;
	}
	return { engine: "brave", results: dedupeByUrl(results) };
}

/**
 * Search the web. SearXNG is primary; the Brave fallback only runs when
 * `BRAVE_API_KEY` is set. Throws with setup hints when no engine answers.
 */
export async function searchWeb(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
	const q = query.trim();
	if (!q) throw new Error("web_search needs a non-empty query.");
	const maxResults = clamp(opts.maxResults ?? RESULTS_DEFAULT, 1, RESULTS_CAP);
	const fetchImpl = opts.fetchImpl ?? fetch;
	const failures: string[] = [];

	try {
		return await searxngSearch(q, maxResults, fetchImpl, opts.signal);
	} catch (err) {
		failures.push(`SearXNG: ${err instanceof Error ? err.message : String(err)}`);
	}

	const apiKey = process.env.BRAVE_API_KEY;
	if (apiKey) {
		try {
			return await braveSearch(q, maxResults, fetchImpl, apiKey, opts.signal);
		} catch (err) {
			failures.push(`Brave: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	throw new Error(
		`Web search failed (${failures.join("; ")}). ` +
			`Start the SearXNG instance with \`docker compose up -d\` from the recon-tools dir, ` +
			`point SEARXNG_URL at another instance, or set BRAVE_API_KEY to enable the Brave fallback.`,
	);
}

// --- fetch ------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&#39;": "'",
	"&nbsp;": " ",
};

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&[a-zA-Z]+;|&#\d+;/g, (m) => ENTITIES[m] ?? m);
}

/** Reduce an HTML document to a title plus readable plain text. */
export function htmlToText(html: string): { title: string; text: string } {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "")).trim() : "";
	// Drop <head> (and any stray <title>) so the title is not repeated in the body.
	const body = html
		.replace(/<head[\s\S]*?<\/head>/gi, " ")
		.replace(/<title[\s\S]*?<\/title>/gi, " ");
	const text = decodeEntities(
		body
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<li[^>]*>/gi, "\n- ")
			.replace(/<\/(p|div|tr|h[1-6]|blockquote|pre|section|article|header|footer|table)>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	return { title, text };
}

/** Fetch one http(s) URL and return its readable text, truncated to a budget. */
export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Only http(s) URLs can be fetched, got ${parsed.protocol}`);
	}
	const envMax = Number(process.env.PI_FLEET_FETCH_MAX_CHARS);
	const maxChars = clamp(
		opts.maxChars ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : FETCH_CHARS_DEFAULT),
		FETCH_CHARS_MIN,
		FETCH_CHARS_MAX,
	);
	const fetchImpl = opts.fetchImpl ?? fetch;

	const res = await fetchImpl(parsed.toString(), {
		headers: {
			Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
			"User-Agent": USER_AGENT,
		},
		signal: signalOrTimeout(opts.signal, FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);

	const contentType = res.headers.get("content-type") ?? "";
	const raw = await res.text();
	const looksHtml = /html|xml/i.test(contentType) || /<html|<body|<div|<p[ >]/i.test(raw.slice(0, 2000));

	let title = "";
	let text = raw;
	if (looksHtml) {
		const reduced = htmlToText(raw);
		title = reduced.title;
		text = reduced.text;
	}
	const truncated = text.length > maxChars;
	if (truncated) text = text.slice(0, maxChars);
	return { url, finalUrl: res.url || parsed.toString(), title, text, truncated };
}

// --- formatting -------------------------------------------------------------

/** Compact numbered result list; keeps token cost proportional to signal. */
export function formatSearchResults(outcome: SearchOutcome): string {
	if (outcome.results.length === 0) return "No results.";
	return outcome.results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
		.join("\n");
}

export function formatFetchedPage(outcome: FetchOutcome): string {
	const head = [`# ${outcome.title || "(untitled)"}`, `Source: ${outcome.finalUrl}`].join("\n");
	const body = outcome.truncated ? `${outcome.text}\n\n[truncated at ${outcome.text.length} chars]` : outcome.text;
	return `${head}\n\n${body}`;
}
