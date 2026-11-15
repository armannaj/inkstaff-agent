import "server-only";
import { z } from "zod";
import {
  AGENT_MAX_PAID_DATA_CALLS,
  AGENT_MAX_READS,
  AGENT_MAX_SEARCHES,
  AGENT_MAX_TRANSCRIPTS,
  AGENT_MAX_VIDEO_SEARCHES,
  AGENT_PAID_DATA_BUDGET_USD,
  EMBEDDING_MODEL,
} from "@/lib/config";
import { indexedPages } from "../store";
import { fetchPage } from "../web/fetch-page";
import { youtubeVideoId } from "../web/youtube";
import { htmlToMarkdown } from "../web/markdown";
import { hasSearchConsole, propertyFor, searchAnalytics } from "../web/search-console";
import { isExcluded, publicUrl, samePage } from "../web/url-safety";
import type { AgentProviders } from "../providers";
import type { FailedRead, Source, WorkerAgent } from "../types";
import { defineTool, refuse, type AgentTool, type ToolContext } from "./types";

/** Raw pages and API responses go to the model whole: the 2 MB download limit is the only bound. */
export const FULL_RESULT_CHARS = 2_000_000;

/** A page's text as a browser shows it: a full-page screenshot read by the vision model. For pages drawn by JavaScript. */
async function renderedText(url: string, providers: AgentProviders) {
  if (!providers.screenshot) throw new Error("Rendering pages needs SCREENSHOTENGINE_API_KEY.");
  const shot = await providers.screenshot(url, { fullPage: true });
  return providers.vision(
    `data:${shot.mimeType};base64,${shot.base64}`,
    "Transcribe the readable content of this web page as plain text, in reading order: headings, plan names, prices with their billing period and currency, limits and feature lists, and the text of tables. Only what is visible; don't describe images or add anything.",
  );
}

export function nextSourceId(sources: Source[]) {
  const numbers = sources.map((s) => Number(/^source-(\d+)$/.exec(s.id)?.[1] ?? 0));
  return `source-${Math.max(0, ...numbers) + 1}`;
}

const LIMITS = { searches: AGENT_MAX_SEARCHES, reads: AGENT_MAX_READS };
type Counter = keyof typeof LIMITS;
/** Searches or page reads this agent has left for the article: each agent that researches has its own allowance. */
function left({ article, agent }: Pick<ToolContext, "article" | "agent">, counter: Counter) {
  const used = article.state.usage[`${counter}By`]?.[agent] ?? 0;
  return Math.max(0, (LIMITS[counter][agent] ?? 0) - used);
}
/** Counts a search or page read that worked, for the article and against the agent's allowance. */
function count({ article, agent }: Pick<ToolContext, "article" | "agent">, counter: Counter) {
  const { usage } = article.state;
  usage[counter]++;
  const by = (usage[`${counter}By`] ??= {});
  by[agent] = (by[agent] ?? 0) + 1;
}

/**
 * A page with less readable text than this gave the agent nothing: an empty shell drawn by JavaScript, a login page,
 * a bot check. It doesn't become a source and doesn't use up a page read.
 */
const MIN_READABLE_CHARS = 200;
/** How much text a reader would see in a page's Markdown: link and image addresses and markup don't count. */
export function readableChars(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[#*_>|`[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/** The earlier failure of this page with this tool, if any: it isn't tried again. */
const failedBefore = (failed: FailedRead[] | undefined, tool: FailedRead["tool"], url: string) =>
  failed?.find((f) => f.tool === tool && samePage(f.url, url));
/** Remembers that a page couldn't be read, and tells the agent what it can still do. Uses up no page read. */
function failedRead(ctx: ToolContext, tool: FailedRead["tool"], url: string, error: unknown) {
  const reason = error instanceof Error ? error.message.slice(0, 200) : "unavailable";
  (ctx.article.state.failedReads ??= []).push({ tool, url, reason });
  return refuse(`Could not ${tool === "read_page" ? "read" : "render"} the page: ${reason} It didn't use up a page read. ${wayOn(tool, reason)}`);
}
/** What is left to try after a failure: a page too big or too empty to read may still render; a missing one won't. */
const wayOn = (tool: FailedRead["tool"], reason: string) =>
  tool === "read_page" && /almost no readable text|2 MB/.test(reason)
    ? "Try view_page to see it as a browser shows it, or another address."
    : "Try another address.";

/**
 * Fetches a page and adds it as a source: raw HTML stored for agents, extracted text kept for code checks. A page with
 * almost no readable text is an error, not a source.
 */
async function addSource(ctx: ToolContext, url: string, fallbackTitle = url) {
  const { article, assets } = ctx;
  const { state } = article;
  const fetched = await fetchPage(url);
  const known = state.sources.find((s) => samePage(s.url, fetched.url));
  if (known) return { source: known, markdown: "", existed: true };
  const markdown = htmlToMarkdown(fetched.html, fetched.url);
  if (readableChars(markdown) < MIN_READABLE_CHARS)
    throw new Error(
      `${samePage(url, fetched.url) ? "The page" : `It led to ${fetched.url}, which`} came back with almost no readable text (drawn by JavaScript, a login page or a bot check).`,
    );
  const id = nextSourceId(state.sources);
  const rawAssetId = `${article.id}-${id}-html`;
  await assets.save(rawAssetId, article.id, { base64: Buffer.from(fetched.html).toString("base64"), mimeType: "text/html" });
  const source: Source = {
    id,
    url: fetched.url,
    title: fetched.page.title || fetched.page.h1 || fallbackTitle,
    publisher: new URL(fetched.url).hostname,
    publicationDate: fetched.page.publicationDate ?? fetched.page.lastModified ?? null,
    accessedAt: new Date().toISOString(),
    content: fetched.page.content,
    facts: [],
    credibility: "",
    sourceType: "other",
    rawAssetId,
  };
  if (!(state.existingPost && samePage(fetched.url, state.existingPost.url))) state.sources.push(source);
  return { source, markdown, existed: false };
}
/** A source's raw HTML; pages read before raw storage (and rendered views) only have text. */
async function rawOf(ctx: ToolContext, source: Source) {
  if (!source.rawAssetId) return null;
  const asset = await ctx.assets.get(source.rawAssetId);
  return asset ? Buffer.from(asset.base64, "base64").toString("utf8") : null;
}

function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const readSource = defineTool({
  name: "read_source",
  description:
    "A page already read (source-N), by any agent: the whole page as Markdown (every heading, paragraph, table, link and image with its alt text and address), converted from the raw HTML as fetched; plus any rendered text from view_page.",
  schema: z.object({ sourceId: z.string() }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ sourceId }, ctx) {
    const source = ctx.article.state.sources.find((s) => s.id === sourceId);
    if (!source) return refuse(`There is no source "${sourceId}".`);
    const html = await rawOf(ctx, source);
    const rendered = source.content.includes("As rendered in a browser:") ? source.content.split("As rendered in a browser:").slice(1).join("") : null;
    return {
      id: source.id,
      url: source.url,
      ...(html ? { markdown: htmlToMarkdown(html, source.url) } : { text: source.content }),
      ...(html && rendered ? { renderedText: rendered } : {}),
    };
  },
});

const NO_SEARCHES = "You have no searches left for this article. Work with what was found.";
const NO_READS = "You have no page reads left for this article. Work with the pages already read (read_source).";

const webSearch = defineTool({
  name: "web_search",
  description:
    "Google search through DataForSEO: its whole response, with every result type Google showed (organic results, people also ask, featured snippet, AI overview, related searches, videos, discussions and more). depth = how many results (billed per 10).",
  schema: z.object({ query: z.string().min(3).max(200), depth: z.number().int().min(10).max(100).default(10) }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ query, depth }, ctx) {
    const { article, providers, log } = ctx;
    const { state } = article;
    const key = `${query.trim().toLowerCase()}|${depth}`;
    state.searchCache ??= {};
    if (state.searchCache[key]) return state.searchCache[key];
    if (!left(ctx, "searches")) return refuse(NO_SEARCHES);
    // Counted once it succeeds: a DataForSEO error doesn't use up the limit.
    const { response } = await providers.serp(query, depth);
    count(ctx, "searches");
    log(`Searched "${query}"`);
    state.searchCache[key] = response;
    return response;
  },
});

const readPageTool = defineTool({
  name: "read_page",
  description:
    "Fetch a web page and get the whole page as Markdown (every heading, paragraph, table, link and image with its alt text and address), converted from the raw HTML as fetched; it becomes a source (source-N) that can be cited and linked. A page drawn by JavaScript has little content in its HTML: use view_page to see it rendered. You may read an address you expect to exist, such as a product's official pricing page. A page that can't be read, or comes back with almost no text, uses up no page read and isn't tried again.",
  schema: z.object({ url: z.string().url() }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ url }, ctx) {
    const { state } = ctx.article;
    if (!left(ctx, "reads")) return refuse(NO_READS);
    const known = state.sources.find((s) => samePage(s.url, url));
    if (known) return refuse(`Already read as ${known.id}; use read_source.`);
    if (state.existingPost && samePage(url, state.existingPost.url))
      return refuse("This is the post being rewritten. Its text is in your brief; it can't be a source.");
    if (isExcluded(url, state.website.excludedPages)) return refuse("The author excluded this page.");
    const failed = failedBefore(state.failedReads, "read_page", url);
    if (failed) return refuse(`This address already failed (${failed.reason}) and isn't tried again. ${wayOn("read_page", failed.reason)}`);
    let read: Awaited<ReturnType<typeof addSource>>;
    try {
      read = await addSource(ctx, url);
    } catch (error) {
      return failedRead(ctx, "read_page", url, error);
    }
    const { source, markdown, existed } = read;
    if (existed) return refuse(`It redirects to ${source.url}, already read as ${source.id}.`);
    // Counted once it worked: a page that can't be read doesn't use up the allowance.
    count(ctx, "reads");
    ctx.log(`Read ${source.url} (${source.id})`);
    return { id: source.id, url: source.url, markdown, pageReadsLeft: left(ctx, "reads") };
  },
});

const viewPage = defineTool({
  name: "view_page",
  description:
    "See a page as a browser shows it (rendered, read by vision): for content that read_page misses, such as prices or tables drawn by JavaScript. Adds the rendered text to the page's source (or creates one). Counts as a page read when it works; a page that can't be rendered isn't tried again.",
  schema: z.object({ url: z.string().url() }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ url }, ctx) {
    const { article, providers, log } = ctx;
    const { state } = article;
    if (!left(ctx, "reads")) return refuse(NO_READS);
    if (state.existingPost && samePage(url, state.existingPost.url)) return refuse("This is the post being rewritten; it can't be a source.");
    try {
      publicUrl(url);
    } catch {
      return refuse("Only public http(s) addresses can be viewed.");
    }
    const failed = failedBefore(state.failedReads, "view_page", url);
    if (failed) return refuse(`This address already failed to render (${failed.reason}) and isn't tried again. Try another address.`);
    let text: string;
    try {
      text = await renderedText(url, providers);
    } catch (error) {
      return failedRead(ctx, "view_page", url, error);
    }
    count(ctx, "reads");
    const existing = state.sources.find((s) => samePage(s.url, url));
    const source: Source = existing ?? {
      id: nextSourceId(state.sources),
      url,
      title: url,
      publisher: new URL(url).hostname,
      publicationDate: null,
      accessedAt: new Date().toISOString(),
      content: "",
      facts: [],
      credibility: "",
      sourceType: "other",
    };
    source.content = existing ? `${existing.content}\n\nAs rendered in a browser:\n${text}` : text;
    if (!existing) state.sources.push(source);
    log(`Viewed ${url} as rendered (${source.id})`);
    return { id: source.id, url, text, pageReadsLeft: left(ctx, "reads") };
  },
});

const serpOverview = defineTool({
  name: "serp_overview",
  description:
    "What ranks for a keyword: DataForSEO's Google response exactly as returned (every result type, the AI overview with its references included), and the top organic pages opened, each one that could be read added as a source (the whole page via read_source). One search; the opened pages don't count as page reads.",
  schema: z.object({
    keyword: z.string().min(2).max(200),
    pages: z.number().int().min(1).max(10).default(8).describe("How many top organic results to open."),
    depth: z.number().int().min(10).max(100).default(10).describe("How many results DataForSEO returns (billed per 10)."),
  }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ keyword, pages, depth }, ctx) {
    const { state } = ctx.article;
    const key = `${keyword.trim().toLowerCase()}|${pages}|${depth}`;
    state.serpOverviews ??= {};
    if (state.serpOverviews[key]) return state.serpOverviews[key];
    if (!left(ctx, "searches")) return refuse(NO_SEARCHES);
    const { response, organic } = await ctx.providers.serp(keyword, depth);
    count(ctx, "searches");
    const opened: { position: number; url: string; sourceId?: string; error?: string }[] = [];
    for (const result of organic.slice(0, pages)) {
      try {
        const { source } = await addSource(ctx, result.url, result.title);
        opened.push({ position: result.position, url: source.url, ...(state.sources.includes(source) ? { sourceId: source.id } : {}) });
      } catch (error) {
        opened.push({ position: result.position, url: result.url, error: error instanceof Error ? error.message.slice(0, 120) : "unreadable" });
      }
    }
    const overview = { keyword, dataforseo: response, openedPages: opened };
    state.serpOverviews[key] = overview;
    ctx.log(`Looked at what ranks for "${keyword}" (${opened.filter((p) => p.sourceId).length} pages opened)`);
    return overview;
  },
});

const keywordData = defineTool({
  name: "keyword_data",
  description: `Keyword data for up to 20 keywords: DataForSEO Labs' keyword overview exactly as returned (search volume and its monthly history, volume trend, CPC, competition and bids, keyword difficulty, search intent, SERP features). PAID: counts against the data limit (${AGENT_MAX_PAID_DATA_CALLS} calls per article).`,
  schema: z.object({ keywords: z.array(z.string().min(1).max(80)).min(1).max(20) }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ keywords }, { article, providers, log }) {
    const { usage } = article.state;
    if (usage.paidDataCalls >= AGENT_MAX_PAID_DATA_CALLS || usage.paidDataUsd >= AGENT_PAID_DATA_BUDGET_USD)
      return refuse("The paid data budget for this article is used up.");
    const { response, costUsd } = await providers.keywordData([...new Set(keywords.map((k) => k.trim().toLowerCase()))]);
    usage.paidDataCalls++;
    usage.paidDataUsd += costUsd;
    log(`Looked up keyword data for ${keywords.length} keyword${keywords.length === 1 ? "" : "s"}`);
    return response;
  },
});

const searchConsole = defineTool({
  name: "search_console",
  description:
    "The product site's own Google Search Console data, exactly as the Search Analytics API returns it (rows of keys, clicks, impressions, ctr, position; about two days behind). Choose the dimensions and filters, e.g. one page's queries, or the pages that show up for some words.",
  schema: z.object({
    dimensions: z.array(z.enum(["query", "page", "country", "device", "date", "searchAppearance"])).min(1).default(["query"]),
    page: z.string().url().optional().describe("Only this page (exact URL)."),
    queryContains: z.string().min(2).max(100).optional(),
    days: z.number().int().min(7).max(480).default(90),
    rowLimit: z.number().int().min(1).max(25000).default(1000),
  }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ dimensions, page, queryContains, days, rowLimit }, { article, log }) {
    if (!hasSearchConsole()) return refuse("Search Console isn't connected (GSC_CREDENTIALS_PATH).");
    const property = await propertyFor(article.state.website.websiteUrl);
    if (!property)
      return refuse(`Search Console has no property for ${article.state.website.websiteUrl} that the service account can read.`);
    const result = await searchAnalytics(property, { dimensions, page, queryContains, days, rowLimit });
    log(`Checked Search Console${page ? ` for ${page}` : ""}${queryContains ? ` ("${queryContains}")` : ""}`);
    return { property, ...result };
  },
});

const sitePages = defineTool({
  name: "site_pages",
  description:
    "Pages of the product's own website related to a topic, from its index: each page's URL, title, a short summary of what it is, when it last changed and its similarity to the query. read_page returns a page's full text. Pages returned may be linked from the article.",
  schema: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(50).default(12) }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ query, limit }, { article, providers, log }) {
    const { state } = article;
    const pages = (await indexedPages(article.productId)).filter(
      (p) => p.embeddingModel === EMBEDDING_MODEL && !isExcluded(p.canonicalUrl, state.website.excludedPages),
    );
    if (!pages.length)
      return refuse("The product's website isn't indexed. The author can index it under Products → Index website.");
    const [vector] = await providers.embed([query]);
    const best = pages
      .map((p) => ({ page: p, similarity: cosine(vector, p.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    for (const { page } of best)
      if (!state.sitePages.some((p) => p.url === page.canonicalUrl))
        state.sitePages.push({ url: page.canonicalUrl, title: page.title, summary: page.summary });
    log(`Looked up site pages for "${query}" (${best.length})`);
    // What each page is; its full text comes from read_page, so repeated lookups don't fill the conversation.
    return best.map(({ page, similarity }) => ({
      url: page.canonicalUrl,
      title: page.title,
      summary: page.summary,
      lastModified: page.lastModified,
      similarity,
    }));
  },
});

/** The tools the Research and Editor agents share. */
export const searchYoutube = defineTool({
  name: "search_youtube",
  description:
    "Search YouTube through DataForSEO: its whole response (videos with title, channel, views, duration and date; channels; playlists). The Editor can plan videos found here.",
  schema: z.object({ query: z.string().min(2).max(200) }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ query }, { article, providers, log }) {
    const { state } = article;
    const key = query.trim().toLowerCase();
    state.youtubeCache ??= {};
    if (state.youtubeCache[key]) return state.youtubeCache[key];
    if (state.usage.videoSearches >= AGENT_MAX_VIDEO_SEARCHES) return refuse("No YouTube searches left for this article.");
    const response = await providers.youtube(query);
    state.usage.videoSearches++;
    state.youtubeCache[key] = response;
    log(`Searched YouTube for "${query}"`);
    return response;
  },
});

const videoTranscript = defineTool({
  name: "video_transcript",
  description: `What a YouTube video says: its subtitles with timings, DataForSEO's response exactly as returned (empty when the video has none). Limit ${AGENT_MAX_TRANSCRIPTS} per article.`,
  schema: z.object({ url: z.string().describe("The video's YouTube URL.") }),
  maxResultChars: FULL_RESULT_CHARS,
  async run({ url }, { article, providers, log }) {
    const { state } = article;
    const id = youtubeVideoId(url);
    if (!id) return refuse("That isn't a YouTube video URL.");
    state.transcriptCache ??= {};
    if (state.transcriptCache[id]) return state.transcriptCache[id];
    if ((state.usage.transcripts ?? 0) >= AGENT_MAX_TRANSCRIPTS) return refuse("No transcripts left for this article.");
    const response = await providers.youtubeSubtitles(id);
    state.usage.transcripts = (state.usage.transcripts ?? 0) + 1;
    state.transcriptCache[id] = response;
    log(`Read the transcript of ${url}`);
    return response;
  },
});

/** The research tools as one agent gets them: the search and read tools say that agent's own allowance. */
export const researchTools = (agent: WorkerAgent): AgentTool[] => {
  const searches = `You have ${AGENT_MAX_SEARCHES[agent] ?? 0} searches for this article (web_search and serp_overview together).`;
  const reads = `You have ${AGENT_MAX_READS[agent] ?? 0} page reads for this article (read_page and view_page together).`;
  const limited = (tool: AgentTool, allowance: string): AgentTool => ({ ...tool, description: `${tool.description} ${allowance}` });
  return [
    keywordData,
    limited(webSearch, searches),
    limited(serpOverview, searches),
    searchYoutube,
    videoTranscript,
    limited(readPageTool, reads),
    limited(viewPage, reads),
    readSource,
    searchConsole,
    sitePages,
  ];
};
