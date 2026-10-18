import { z } from "zod";
import { COVER_STYLE_IDS } from "./agent/media/cover-styles";

export const httpUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Use a public HTTP or HTTPS URL without credentials.");
const optionalUrl = z.union([httpUrlSchema, z.literal("")]);
const text = z.string();
const count = z.union([z.literal("auto"), z.number().int().min(0).max(20)]);

export const productNameSchema = text.trim().min(1, "Give the product a name.").max(200);

/** A product's website and writing settings, copied into each of its articles (and so sent to the models). */
export const websiteSchema = z
  .object({
    websiteUrl: httpUrlSchema,
    sitemapUrl: optionalUrl,
    brandName: text.trim().max(200),
    productDescription: text.max(5000),
    targetAudience: text.max(2000),
    writingGuidelines: text.max(6000),
    priorityPages: z.array(httpUrlSchema).max(100),
    excludedPages: z.array(httpUrlSchema).max(100),
    /** The house style for this product's covers and drawn images (see lib/agent/media/cover-styles.ts). */
    coverStyle: z.enum(COVER_STYLE_IDS).optional(),
  })
  .superRefine((site, ctx) => {
    if (!URL.canParse(site.websiteUrl)) return;
    for (const url of [...site.priorityPages, ...site.excludedPages]) {
      if (!URL.canParse(url)) continue;
      if (new URL(url).origin !== new URL(site.websiteUrl).origin)
        ctx.addIssue({
          code: "custom",
          message: "Priority and excluded pages must belong to the website.",
          path: ["websiteUrl"],
        });
    }
  });
export type WebsiteSettings = z.infer<typeof websiteSchema>;

/** Settings for a new product: its site, with the sitemap at the usual address. */
export function defaultWebsiteSettings(name: string, websiteUrl: string): WebsiteSettings {
  const origin = new URL(websiteUrl).origin;
  return {
    websiteUrl: `${origin}/`,
    sitemapUrl: `${origin}/sitemap.xml`,
    brandName: name,
    productDescription: "",
    targetAudience: "",
    writingGuidelines: "",
    priorityPages: [],
    excludedPages: [],
  };
}

/**
 * Where a product's articles are published: its blog's webhook endpoint and bearer token. Kept apart from
 * WebsiteSettings, which is copied into every article and sent to the model: the token must never be.
 */
export const publishingSettingsSchema = z.object({
  endpointUrl: httpUrlSchema.refine((value) => value.startsWith("https://"), "Use an https URL."),
  token: text.trim().min(1, "Add the endpoint's token."),
});
export type PublishingSettings = z.infer<typeof publishingSettingsSchema>;

/**
 * The S3-compatible storage (Cloudflare R2, AWS S3, MinIO, ...) that holds a product's article images, addressed
 * path-style (endpoint/bucket/key), and the public URL the bucket is read from. Server-only, like the token.
 */
export const storageSettingsSchema = z.object({
  endpoint: httpUrlSchema.refine((value) => value.startsWith("https://"), "Use the storage's https endpoint."),
  region: text.trim().min(1, "Add the region (auto for Cloudflare R2).").max(50),
  accessKeyId: text.trim().min(1, "Add the access key ID."),
  secretAccessKey: text.trim().min(1, "Add the secret access key."),
  bucket: text
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Bucket names are 3-63 lowercase letters, digits, dots and hyphens."),
  publicUrl: httpUrlSchema.refine((value) => value.startsWith("https://"), "Use the bucket's https public URL."),
});
export type StorageSettings = z.infer<typeof storageSettingsSchema>;

/**
 * Whether the article may name products that compete with the author's: "auto" leaves it to the writer's judgment of
 * the search (alternatives and comparisons are about competitors; a product tutorial isn't).
 */
export const COMPETITOR_POLICIES = ["auto", "allowed", "not_allowed"] as const;
/** What an article is for: the agents' measure of success. "auto" on the form leaves it to the Editor. */
export const ARTICLE_GOALS = ["traffic", "signups", "awareness"] as const;
export type ArticleGoal = (typeof ARTICLE_GOALS)[number];
export type CompetitorPolicy = (typeof COMPETITOR_POLICIES)[number];
export function competitorPolicy(input: { mentionCompetitors?: unknown }): CompetitorPolicy {
  const value = input.mentionCompetitors;
  return COMPETITOR_POLICIES.includes(value as CompetitorPolicy) ? (value as CompetitorPolicy) : "auto";
}

export const articleInputSchema = z.object({
  primaryKeyword: text.trim().min(2).max(200),
  additionalKeywords: z.array(text.trim().min(1).max(200)),
  type: z.enum(["article", "listicle"]),
  goal: z.enum(["auto", ...ARTICLE_GOALS]).default("auto"),
  productId: z.number().int().positive(),
  targetAudience: text.max(2000),
  length: z.enum(["auto", "short", "medium", "long", "custom"]),
  customWordCount: z.number().int().min(300).max(8000),
  tone: z.enum(["auto", "conversational", "professional", "technical", "friendly", "opinionated", "educational"]),
  firstPerson: z.boolean(),
  /** "auto" (default) leaves it to the writer: an expert search gets expert prose. */
  readingLevel: z.enum(["auto", "general", "beginner", "intermediate", "expert"]).default("auto"),
  internalLinks: count,
  externalLinks: count,
  /** "auto" (default) leaves the style to the agents. */
  imageStyle: z.enum(["auto", "sketch", "realistic", "illustration"]).default("auto"),
  /** In-article images (the cover is extra). "auto" leaves the number to the agents. */
  imageCount: z.union([z.literal("auto"), z.number().int().min(1).max(5)]).default("auto"),
  mentionCompetitors: z.enum(COMPETITOR_POLICIES).default("auto"),
  /** The author's own data, experience, examples or screenshots described in words: first-party evidence. */
  ownerMaterial: text.max(8000).default(""),
  /** A post already on the product's blog that this article rewrites; publishing replaces it at the same address. */
  rewriteUrl: optionalUrl.default(""),
});
export type ArticleInput = z.infer<typeof articleInputSchema>;
export const DEFAULT_INPUT: Omit<ArticleInput, "productId"> = {
  primaryKeyword: "",
  additionalKeywords: [],
  type: "article",
  goal: "auto",
  targetAudience: "",
  length: "auto",
  customWordCount: 1800,
  tone: "auto",
  firstPerson: false,
  readingLevel: "auto",
  internalLinks: "auto",
  externalLinks: "auto",
  imageStyle: "auto",
  imageCount: "auto",
  mentionCompetitors: "auto",
  ownerMaterial: "",
  rewriteUrl: "",
};
