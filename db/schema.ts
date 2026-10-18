import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentMessage, AgentState, AgentStatus, ArticleInput } from "@/lib/agent/types";
import type { PublishingSettings, StorageSettings, WebsiteSettings } from "@/lib/schemas";

const now = () => new Date();

/** A page of a product's site, read and embedded by the site index (lib/site-index.ts) so articles can link to it. */
export type IndexedPage = {
  url: string;
  title: string;
  metaDescription: string;
  h1: string;
  headings: string[];
  content: string;
  canonicalUrl: string;
  lastModified: string | null;
  summary: string;
  embedding: number[];
  embeddingModel: string;
  indexedAt: string;
};

/** A product the articles are written for: its website and writing settings, and where its articles are published. */
export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  websiteSettings: text("website_settings", { mode: "json" }).$type<WebsiteSettings>().notNull(),
  /** Blog publishing endpoint and token. The token never leaves the server. Null = not configured. */
  publishing: text("publishing", { mode: "json" }).$type<PublishingSettings>(),
  /** S3-compatible storage for article images. The secret key never leaves the server. Null = not configured. */
  storage: text("storage", { mode: "json" }).$type<StorageSettings>(),
  indexQueue: text("index_queue", { mode: "json" }).$type<string[]>().notNull().default([]),
  indexStatus: text("index_status").$type<"idle" | "indexing" | "processing" | "complete" | "failed">().notNull().default("idle"),
  indexError: text("index_error"),
  indexedAt: integer("indexed_at", { mode: "timestamp_ms" }),
  /** Changes with every save and indexing step: the index's lease, and a guard against concurrent saves. */
  contentUpdatedAt: text("content_updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export const productPages = sqliteTable(
  "product_pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    data: text("data", { mode: "json" }).$type<IndexedPage>().notNull(),
  },
  (t) => [uniqueIndex("product_pages_product_url_idx").on(t.productId, t.url)],
);

/** Articles the agents write (lib/agent). */
export const agentArticles = sqliteTable(
  "agent_articles",
  {
    id: text("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    status: text("status").$type<AgentStatus>().notNull().default("queued"),
    input: text("input", { mode: "json" }).$type<Omit<ArticleInput, "productId">>().notNull(),
    state: text("state", { mode: "json" }).$type<AgentState>().notNull(),
    contentMarkdown: text("content_markdown").notNull().default(""),
    wordCount: integer("word_count").notNull().default(0),
    version: integer("version").notNull().default(0),
    error: text("error"),
    /** "pause" or "stop", asked for from the page and acted on by the runner between turns. */
    control: text("control").$type<"pause" | "stop">(),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("agent_articles_updated_idx").on(t.updatedAt), index("agent_articles_status_idx").on(t.status)],
);

/**
 * Agent conversations, one row per message: each run of an agent (the Director's thread or a worker's run) is the rows
 * with its run_id, in id order. Kept out of agent_articles so the article row isn't rewritten with them.
 */
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: text("article_id")
      .notNull()
      .references(() => agentArticles.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    runId: text("run_id").notNull(),
    message: text("message", { mode: "json" }).$type<AgentMessage>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [index("agent_messages_run_idx").on(t.articleId, t.agent, t.runId)],
);

/** Images (screenshots, illustrations, covers) and the raw HTML of pages read. */
export const agentAssets = sqliteTable(
  "agent_assets",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id")
      .notNull()
      .references(() => agentArticles.id, { onDelete: "cascade" }),
    mimeType: text("mime_type").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
  },
  (t) => [index("agent_assets_article_idx").on(t.articleId)],
);
