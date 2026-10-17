import "server-only";
import { asc, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentArticles, productPages, products } from "@/db/schema";
import {
  defaultWebsiteSettings,
  httpUrlSchema,
  productNameSchema,
  publishingSettingsSchema,
  websiteSchema,
  type WebsiteSettings,
} from "@/lib/schemas";

/** A product as its settings page shows it. The publishing token is never included. */
export type ProductView = {
  id: number;
  name: string;
  settings: WebsiteSettings;
  indexStatus: string;
  indexError: string | null;
  indexedCount: number;
  indexedAt: string | null;
  publishing: { endpointUrl: string; mediaBucket: string; mediaPublicUrl: string; hasToken: boolean } | null;
};

export async function listProducts() {
  return getDb()
    .select({ id: products.id, name: products.name, settings: products.websiteSettings })
    .from(products)
    .orderBy(asc(products.name));
}

export async function getProduct(id: number): Promise<ProductView | null> {
  const [product] = await getDb().select().from(products).where(eq(products.id, id));
  if (!product) return null;
  const [{ pages }] = await getDb().select({ pages: count() }).from(productPages).where(eq(productPages.productId, id));
  const { publishing } = product;
  return {
    id: product.id,
    name: product.name,
    settings: product.websiteSettings,
    indexStatus: product.indexStatus,
    indexError: product.indexError,
    indexedCount: pages,
    indexedAt: product.indexedAt?.toISOString() ?? null,
    publishing: publishing && {
      endpointUrl: publishing.endpointUrl,
      mediaBucket: publishing.mediaBucket,
      mediaPublicUrl: publishing.mediaPublicUrl,
      hasToken: !!publishing.token,
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
export async function savePublishingSettings(
  id: number,
  input: { endpointUrl: string; token: string; mediaBucket: string; mediaPublicUrl: string },
) {
  const [product] = await getDb().select({ publishing: products.publishing }).from(products).where(eq(products.id, id));
  if (!product) throw new Error("Product not found.");
  const publishing = publishingSettingsSchema.parse({
    endpointUrl: input.endpointUrl.trim(),
    token: input.token.trim() || product.publishing?.token || "",
    mediaBucket: input.mediaBucket.trim(),
    mediaPublicUrl: input.mediaPublicUrl.trim().replace(/\/+$/, ""),
  });
  await getDb().update(products).set({ publishing }).where(eq(products.id, id));
}

export async function clearPublishingSettings(id: number) {
  await getDb().update(products).set({ publishing: null }).where(eq(products.id, id));
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
