import "server-only";
import { asc, count, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentArticles, productPages, products } from "@/db/schema";
import {
  defaultWebsiteSettings,
  httpUrlSchema,
  productNameSchema,
  publishingSettingsSchema,
  storageSettingsSchema,
  websiteSchema,
  type WebsiteSettings,
} from "@/lib/schemas";
import { isIndexing } from "@/lib/site-index";

/**
 * Where the product's site index stands: built, being built now, stopped part-way (paused, or interrupted by a
 * restart), failed, or never built.
 */
export type IndexState = "complete" | "running" | "paused" | "failed" | "none";
function indexState(productId: number, status: (typeof products.$inferSelect)["indexStatus"], pages: number): IndexState {
  if (isIndexing(productId)) return "running";
  if (status === "indexing" || status === "processing") return "paused";
  if (status === "failed") return "failed";
  return status === "complete" && pages ? "complete" : "none";
}

/** A product as its settings page shows it. The publishing token and the storage's secret key are never included. */
export type ProductView = {
  id: number;
  name: string;
  settings: WebsiteSettings;
  index: IndexState;
  indexError: string | null;
  indexedCount: number;
  /** Pages still queued for indexing. */
  indexRemaining: number;
  indexedAt: string | null;
  publishing: { endpointUrl: string; hasToken: boolean } | null;
  storage: { endpoint: string; region: string; accessKeyId: string; bucket: string; publicUrl: string; hasSecret: boolean } | null;
};

export async function listProducts() {
  const rows = await getDb()
    .select({
      id: products.id,
      name: products.name,
      settings: products.websiteSettings,
      indexStatus: products.indexStatus,
      indexError: products.indexError,
      indexedCount: sql<number>`(select count(*) from ${productPages} where ${productPages.productId} = ${products.id})`,
    })
    .from(products)
    .orderBy(asc(products.name));
  return rows.map(({ indexStatus, ...row }) => ({ ...row, index: indexState(row.id, indexStatus, row.indexedCount) }));
}

export async function getProduct(id: number): Promise<ProductView | null> {
  const [product] = await getDb().select().from(products).where(eq(products.id, id));
  if (!product) return null;
  const [{ pages }] = await getDb().select({ pages: count() }).from(productPages).where(eq(productPages.productId, id));
  const { publishing, storage } = product;
  return {
    id: product.id,
    name: product.name,
    settings: product.websiteSettings,
    index: indexState(product.id, product.indexStatus, pages),
    indexError: product.indexError,
    indexedCount: pages,
    indexRemaining: product.indexQueue.length,
    indexedAt: product.indexedAt?.toISOString() ?? null,
    publishing: publishing && { endpointUrl: publishing.endpointUrl, hasToken: !!publishing.token },
    storage: storage && {
      endpoint: storage.endpoint,
      region: storage.region,
      accessKeyId: storage.accessKeyId,
      bucket: storage.bucket,
      publicUrl: storage.publicUrl,
      hasSecret: !!storage.secretAccessKey,
    },
  };
}

export async function createProduct(input: { name: string; websiteUrl: string }) {
  const name = productNameSchema.parse(input.name);
  const websiteUrl = httpUrlSchema.parse(input.websiteUrl.trim());
  const [created] = await getDb()
    .insert(products)
    .values({ name, websiteSettings: defaultWebsiteSettings(name, websiteUrl) })
    .returning({ id: products.id });
  return created.id;
}

export async function saveProductSettings(id: number, input: { name: string; settings: unknown }) {
  const name = productNameSchema.parse(input.name);
  const settings = websiteSchema.parse(input.settings);
  const [existing] = await getDb().select().from(products).where(eq(products.id, id));
  if (!existing) throw new Error("Product not found.");
  if (existing.indexStatus === "processing" && Date.parse(existing.contentUpdatedAt) > Date.now() - 300_000)
    throw new Error("Wait for the current indexing step to finish before changing the website settings.");
  // Only what decides which pages are indexed resets the index: a new description or cover style doesn't justify
  // reading the whole site again.
  const indexed = (s: WebsiteSettings) => JSON.stringify([s.websiteUrl, s.sitemapUrl, s.priorityPages, s.excludedPages]);
  const resetIndex = indexed(existing.websiteSettings) !== indexed(settings);
  await getDb()
    .update(products)
    .set({
      name,
      websiteSettings: settings,
      contentUpdatedAt: new Date().toISOString(),
      ...(resetIndex ? { indexStatus: "idle" as const, indexQueue: [] } : {}),
    })
    .where(eq(products.id, id));
}

/** Saves where the product's articles are published. The token is write-only: an empty token keeps the saved one. */
export async function savePublishingSettings(id: number, input: { endpointUrl: string; token: string }) {
  const [product] = await getDb().select({ publishing: products.publishing }).from(products).where(eq(products.id, id));
  if (!product) throw new Error("Product not found.");
  const publishing = publishingSettingsSchema.parse({
    endpointUrl: input.endpointUrl.trim(),
    token: input.token.trim() || product.publishing?.token || "",
  });
  await getDb().update(products).set({ publishing }).where(eq(products.id, id));
}

export async function clearPublishingSettings(id: number) {
  await getDb().update(products).set({ publishing: null }).where(eq(products.id, id));
}

/** Saves where the product's article images are stored. The secret key is write-only: empty keeps the saved one. */
export async function saveStorageSettings(
  id: number,
  input: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicUrl: string },
) {
  const [product] = await getDb().select({ storage: products.storage }).from(products).where(eq(products.id, id));
  if (!product) throw new Error("Product not found.");
  const storage = storageSettingsSchema.parse({
    endpoint: input.endpoint.trim().replace(/\/+$/, ""),
    region: input.region.trim() || "auto",
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKey: input.secretAccessKey.trim() || product.storage?.secretAccessKey || "",
    bucket: input.bucket.trim(),
    publicUrl: input.publicUrl.trim().replace(/\/+$/, ""),
  });
  await getDb().update(products).set({ storage }).where(eq(products.id, id));
}

export async function clearStorageSettings(id: number) {
  await getDb().update(products).set({ storage: null }).where(eq(products.id, id));
}

/** Deletes a product and its site index. Refused while it has articles: delete those first. */
export async function deleteProduct(id: number) {
  const [{ articles }] = await getDb()
    .select({ articles: count() })
    .from(agentArticles)
    .where(eq(agentArticles.productId, id));
  if (articles) throw new Error(`This product has ${articles} article${articles === 1 ? "" : "s"}. Delete them first.`);
  await getDb().delete(products).where(eq(products.id, id));
}
