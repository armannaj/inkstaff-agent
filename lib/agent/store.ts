import "server-only";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentArticles, agentAssets, agentMessages, productPages, products } from "@/db/schema";
import { articleInputSchema } from "@/lib/schemas";
import { articleMarkdown, wordCount } from "./content/markdown";
import { readExistingPost } from "./web/fetch-page";
import { normalizedUrl } from "./web/url-safety";
import type {
  AgentArticle,
  AgentMessage,
  AgentName,
  AgentState,
  AgentStatus,
  ArticleInput,
  AssetStore,
  MessageStore,
  TimelineEvent,
  Website,
} from "./types";

/** A turn (one model call plus its tools) can take minutes; the lease is renewed before every turn. */
export const LEASE_MS = 10 * 60_000;

type Row = typeof agentArticles.$inferSelect;
function serialize(row: Row): AgentArticle {
  return {
    ...row,
    input: { ...row.input, productId: row.productId } as ArticleInput,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

export const emptyState = (website: Website): AgentState => ({
  website,
  sources: [],
  sitePages: [],
  sections: [],
  faq: [],
  images: [],
  videos: [],
  reviews: [],
  decisions: [],
  run: null,
  usage: { searches: 0, videoSearches: 0, reads: 0, paidDataCalls: 0, paidDataUsd: 0, images: 0, screenshots: 0 },
  cost: { totalUsd: 0, calls: 0, unpricedCalls: 0, byAgent: {} },
  timeline: [],
  humanNotes: [],
  changedSinceReview: false,
});

/** The product's writing settings, with its indexed home page as the description when none is saved. */
async function productWebsite(productId: number): Promise<Website> {
  const [product] = await getDb().select().from(products).where(eq(products.id, productId));
  if (!product) throw new Error("Choose an existing product.");
  const saved = product.websiteSettings;
  const website: Website = {
    websiteUrl: saved.websiteUrl,
    brandName: saved.brandName || product.name,
    productDescription: saved.productDescription,
    targetAudience: saved.targetAudience,
    writingGuidelines: saved.writingGuidelines,
    excludedPages: saved.excludedPages,
    coverStyle: saved.coverStyle,
  };
  if (website.productDescription.trim()) return website;
  const pages = await getDb()
    .select({ url: productPages.url, data: productPages.data })
    .from(productPages)
    .where(eq(productPages.productId, productId));
  const home = pages.find((p) => normalizedUrl(p.url) === normalizedUrl(website.websiteUrl));
  return home ? { ...website, productDescription: `${home.data.title}. ${home.data.summary}` } : website;
}

/** The product's cover style as saved now (Writing settings): the house style for every image in its articles. */
export async function productCoverStyle(productId: number) {
  const [product] = await getDb().select({ settings: products.websiteSettings }).from(products).where(eq(products.id, productId));
  return product?.settings.coverStyle ?? undefined;
}

export async function createAgentArticle(input: unknown) {
  const { productId, ...articleInput } = articleInputSchema.parse(input);
  const website = await productWebsite(productId);
  // Read now, so an address that can't be rewritten fails before any work is paid for.
  const existingPost = articleInput.rewriteUrl
    ? await readExistingPost(articleInput.rewriteUrl, website.websiteUrl)
    : undefined;
  const id = crypto.randomUUID();
  await getDb()
    .insert(agentArticles)
    .values({
      id,
      productId,
      title: articleInput.primaryKeyword,
      input: articleInput,
      state: { ...emptyState(website), ...(existingPost ? { existingPost } : {}) },
    });
  return id;
}

export async function getAgentArticle(id: string) {
  const [row] = await getDb().select().from(agentArticles).where(eq(agentArticles.id, id));
  return row ? serialize(row) : null;
}

/** What the page shows: everything except source texts and raw search responses, which are large and stay on the server. */
export function articleView(article: AgentArticle): AgentArticle {
  const state = { ...article.state };
  delete state.searchCache;
  delete state.serpOverviews;
  delete state.youtubeCache;
  delete state.transcriptCache;
  return {
    ...article,
    state: {
      ...state,
      sources: article.state.sources.map((s) => ({ ...s, content: "" })),
      existingPost: article.state.existingPost && { ...article.state.existingPost, content: "" },
    },
  };
}

/** The article as the page shows it (articleView). */
export async function getAgentArticleView(id: string) {
  const article = await getAgentArticle(id);
  return article ? articleView(article) : null;
}

/**
 * What a watching page needs every few seconds: the log lines from `since` on (the page drops the ones it has), the
 * status and the current agent, picked out in the database; the rest of the view only when the page asks for it and the
 * article changed. A running article's state holds megabytes of page texts and search responses.
 */
export async function pollAgentArticle(id: string, since: string, version: number, withView: boolean) {
  const [row] = await getDb()
    .select({
      status: agentArticles.status,
      version: agentArticles.version,
      title: agentArticles.title,
      wordCount: agentArticles.wordCount,
      error: agentArticles.error,
      control: agentArticles.control,
      run: sql<string | null>`json_extract(${agentArticles.state}, '$.run')`,
      events: sql<string>`(select coalesce(json_group_array(json(t.value)), '[]') from json_each(${agentArticles.state}, '$.timeline') t where json_extract(t.value, '$.at') >= ${since})`,
    })
    .from(agentArticles)
    .where(eq(agentArticles.id, id));
  if (!row) return null;
  let state: AgentState | null = null;
  if (withView && row.version !== version) {
    const article = await getAgentArticle(id);
    if (article) {
      state = articleView(article).state;
      delete (state as Partial<AgentState>).timeline;
    }
  }
  return {
    ...row,
    run: (row.run ? JSON.parse(row.run) : null) as AgentState["run"],
    events: JSON.parse(row.events) as TimelineEvent[],
    state,
  };
}

export async function listAgentArticles() {
  return getDb()
    .select({
      id: agentArticles.id,
      productName: products.name,
      title: agentArticles.title,
      status: agentArticles.status,
      coverAssetId: sql<string | null>`json_extract(${agentArticles.state}, '$.cover.assetId')`,
      currentAgent: sql<string | null>`json_extract(${agentArticles.state}, '$.run.agent')`,
      costUsd: sql<number | null>`json_extract(${agentArticles.state}, '$.cost.totalUsd')`,
      wordCount: agentArticles.wordCount,
      publishedAt: agentArticles.publishedAt,
      publishedUrl: sql<string | null>`json_extract(${agentArticles.state}, '$.publication.url')`,
      updatedAt: agentArticles.updatedAt,
    })
    .from(agentArticles)
    .innerJoin(products, eq(agentArticles.productId, products.id))
    .orderBy(desc(agentArticles.updatedAt))
    .limit(100);
}

const leaseFree = () => or(isNull(agentArticles.leaseUntil), lt(agentArticles.leaseUntil, new Date()));

/** Articles the runner should work on: queued, or running with an expired lease (the server stopped mid-run). */
export async function claimableIds(limit: number) {
  const rows = await getDb()
    .select({ id: agentArticles.id })
    .from(agentArticles)
    .where(and(inArray(agentArticles.status, ["queued", "running"]), leaseFree()))
    .orderBy(asc(agentArticles.updatedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Takes the article for the runner. Null when another worker holds it or it isn't runnable any more. */
export async function claimForRun(id: string) {
  const token = crypto.randomUUID();
  const [row] = await getDb()
    .update(agentArticles)
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), status: "running", error: null })
    .where(and(eq(agentArticles.id, id), inArray(agentArticles.status, ["queued", "running"]), leaseFree()))
    .returning();
  return row ? { article: serialize(row), token } : null;
}

/** For editor actions: the article must be idle (no lease) and unchanged since the page loaded it. */
export async function acquireIdle(id: string, version: number) {
  const token = crypto.randomUUID();
  const [row] = await getDb()
    .update(agentArticles)
    .set({ leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(agentArticles.id, id), eq(agentArticles.version, version), leaseFree()))
    .returning();
  if (!row) throw new Error("This article changed or the agents are working on it. Reload it first.");
  return { article: serialize(row), token };
}

/** Saves the article under the caller's lease. `keepLease` renews it (the runner); otherwise it is released. */
export async function commitAgentArticle(
  article: AgentArticle,
  token: string,
  changes: {
    state?: AgentState;
    status?: AgentStatus;
    error?: string | null;
    control?: AgentArticle["control"];
    publishedAt?: Date;
    keepLease?: boolean;
  },
) {
  const state = changes.state ?? article.state;
  const markdown = articleMarkdown(state);
  const [row] = await getDb()
    .update(agentArticles)
    .set({
      state,
      status: changes.status ?? article.status,
      title: state.metadata?.h1 || state.plan?.h1 || article.title,
      contentMarkdown: markdown,
      wordCount: wordCount(markdown),
      error: changes.error === undefined ? article.error : changes.error,
      ...(changes.control !== undefined ? { control: changes.control } : {}),
      ...(changes.publishedAt ? { publishedAt: changes.publishedAt } : {}),
      updatedAt: new Date(),
      version: article.version + 1,
      leaseToken: changes.keepLease ? token : null,
      leaseUntil: changes.keepLease ? new Date(Date.now() + LEASE_MS) : null,
    })
    .where(and(eq(agentArticles.id, article.id), eq(agentArticles.leaseToken, token)))
    .returning({ version: agentArticles.version, updatedAt: agentArticles.updatedAt });
  if (!row) throw new Error("The article's lease was lost. Reload it.");
  return {
    ...article,
    state,
    status: changes.status ?? article.status,
    title: state.metadata?.h1 || state.plan?.h1 || article.title,
    contentMarkdown: markdown,
    wordCount: wordCount(markdown),
    error: changes.error === undefined ? article.error : changes.error,
    ...(changes.control !== undefined ? { control: changes.control } : {}),
    ...(changes.publishedAt ? { publishedAt: changes.publishedAt.toISOString() } : {}),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Releases a lease without changes (an editor action that failed). */
export async function releaseLease(id: string, token: string) {
  await getDb()
    .update(agentArticles)
    .set({ leaseToken: null, leaseUntil: null })
    .where(and(eq(agentArticles.id, id), eq(agentArticles.leaseToken, token)));
}

/** Page controls that don't need a lease: they are read by the runner between turns. */
export async function setControl(id: string, control: AgentArticle["control"]) {
  await getDb().update(agentArticles).set({ control }).where(eq(agentArticles.id, id));
}
export async function readControl(id: string) {
  const [row] = await getDb()
    .select({ control: agentArticles.control })
    .from(agentArticles)
    .where(eq(agentArticles.id, id));
  return row?.control ?? null;
}

/** Queues a paused, finished or failed article (Resume, or a note to the agents). */
export async function requeue(id: string, update?: (state: AgentState) => AgentState) {
  const article = await getAgentArticle(id);
  if (!article) throw new Error("Article not found.");
  if (article.status === "queued" || article.status === "running") return article;
  const { token } = await acquireIdle(id, article.version);
  return commitAgentArticle(article, token, {
    state: update ? update(structuredClone(article.state)) : article.state,
    status: "queued",
    control: null,
    error: null,
  });
}

export async function deleteAgentArticle(id: string) {
  const deleted = await getDb()
    .delete(agentArticles)
    .where(and(eq(agentArticles.id, id), leaseFree()))
    .returning({ id: agentArticles.id });
  return deleted.length > 0;
}

export async function runMessages(articleId: string, agent: AgentName, runId: string): Promise<AgentMessage[]> {
  const rows = await getDb()
    .select({ message: agentMessages.message })
    .from(agentMessages)
    .where(and(eq(agentMessages.articleId, articleId), eq(agentMessages.agent, agent), eq(agentMessages.runId, runId)))
    .orderBy(asc(agentMessages.id));
  return rows.map((r) => r.message);
}

/** Adds a turn's messages to the run's conversation, together. */
export async function appendMessages(articleId: string, agent: AgentName, runId: string, messages: AgentMessage[]) {
  if (!messages.length) return;
  await getDb()
    .insert(agentMessages)
    .values(messages.map((message) => ({ articleId, agent, runId, message })));
}

export async function saveAsset(id: string, articleId: string, image: { base64: string; mimeType: string }) {
  const values = { mimeType: image.mimeType, data: Buffer.from(image.base64, "base64") };
  await getDb()
    .insert(agentAssets)
    .values({ id, articleId, ...values })
    .onConflictDoUpdate({ target: agentAssets.id, set: values });
}
export async function getAsset(id: string) {
  const [asset] = await getDb()
    .select({ mimeType: agentAssets.mimeType, data: agentAssets.data })
    .from(agentAssets)
    .where(eq(agentAssets.id, id));
  return asset ? { mimeType: asset.mimeType, base64: asset.data.toString("base64") } : null;
}

export const dbAssets: AssetStore = { save: saveAsset, get: getAsset };
export const dbMessages: MessageStore = { load: runMessages, append: appendMessages };

/** The product's publishing settings (endpoint, token, bucket). Never sent to the page or a model. */
export async function publishingSettings(productId: number) {
  const [product] = await getDb()
    .select({ publishing: products.publishing, settings: products.websiteSettings })
    .from(products)
    .where(eq(products.id, productId));
  return product ? { publishing: product.publishing, host: new URL(product.settings.websiteUrl).host } : null;
}

/** The product's indexed pages, for internal links. Kept for a few minutes: each carries its embedding (~30 KB). */
const pageCache = new Map<number, { at: number; pages: (typeof productPages.$inferSelect)["data"][] }>();
const PAGE_CACHE_MS = 10 * 60_000;
export async function indexedPages(productId: number) {
  const cached = pageCache.get(productId);
  if (cached && Date.now() - cached.at < PAGE_CACHE_MS) return cached.pages;
  const rows = await getDb()
    .select({ data: productPages.data })
    .from(productPages)
    .where(eq(productPages.productId, productId));
  const pages = rows.map((r) => r.data);
  pageCache.set(productId, { at: Date.now(), pages });
  return pages;
}
