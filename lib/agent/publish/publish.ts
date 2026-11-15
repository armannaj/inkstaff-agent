import "server-only";
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import sharp from "sharp";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { publishMarkdown, type PlacedAssets } from "../content/markdown";
import { MEDIA_WIDTH } from "../content/export";
import rehypeStringify from "rehype-stringify";
import type { PublishingSettings, StorageSettings } from "@/lib/schemas";
import { getAsset, indexedBlogPages, publishedArticles } from "../store";
import type { AgentArticle, AgentState, Publication, PublishTarget } from "../types";

/** Public URLs of uploaded images, by asset ID. */
type PublishedAssets = PlacedAssets;
/** The body the site receives (laid out in content/markdown.ts, where the Reviewer's view of the page comes from too). */
export { publishMarkdown };
/** content_html: the same body as HTML, video players included (the only HTML in it is what publishMarkdown adds). */
export function markdownToHtml(markdown: string) {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify, { allowDangerousHtml: true })
      .processSync(markdown),
  );
}
export function slugify(value: string, max = 60) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}
/** An image as it goes out (to the blog, or in an export): WebP, at most `width` wide. */
export function blogWebp(base64: string, width: number) {
  return sharp(Buffer.from(base64, "base64")).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}

/**
 * The product's S3-compatible storage the images are uploaded to (Cloudflare R2, AWS S3, MinIO, ...), addressed
 * path-style: endpoint/bucket/key.
 */
function bucketClient(storage: StorageSettings) {
  const { accessKeyId, secretAccessKey, region } = storage;
  return new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });
}
const objectUrl = (storage: StorageSettings, key: string) => `${storage.endpoint}/${storage.bucket}/${key}`;

/** Uploads the cover and images as WebP under descriptive, content-addressed keys; unchanged ones aren't sent again. */
async function uploadImages(article: AgentArticle, storage: StorageSettings | null, slug: string) {
  const { state } = article;
  const wanted = [
    ...(state.cover?.assetId ? [{ assetId: state.cover.assetId, name: "cover", width: MEDIA_WIDTH.cover }] : []),
    ...state.images.flatMap((i) => (i.assetId ? [{ assetId: i.assetId, name: i.altText, width: MEDIA_WIDTH.image }] : [])),
  ];
  const previous = state.publication?.assets ?? {};
  const assets: PublishedAssets = {};
  let client: AwsClient | undefined;
  for (const { assetId, name, width } of wanted) {
    const asset = await getAsset(assetId);
    if (!asset) continue;
    if (!storage) throw new Error("Set up image storage for this product first (Products → Image storage).");
    const body = await blogWebp(asset.base64, width);
    const key = `${slug}/${slugify(name) || "image"}-${createHash("sha256").update(body).digest("hex").slice(0, 8)}.webp`;
    const url = `${storage.publicUrl}/${key}`;
    if (previous[assetId] !== url) {
      client ??= bucketClient(storage);
      const response = await client.fetch(objectUrl(storage, key), {
        method: "PUT",
        body: new Uint8Array(body),
        headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" },
      });
      if (!response.ok)
        throw new Error(`Uploading ${key} to the bucket "${storage.bucket}" failed (HTTP ${response.status}).`);
    }
    assets[assetId] = url;
  }
  return assets;
}

/**
 * The bucket keys of a post's uploaded images, once each. Every image is uploaded as <slug>/<file>, so the key is read
 * from the end of its URL: that still finds it after the bucket's public URL changed (a new domain for the same bucket).
 */
function storageKeys(urls: string[], slug: string) {
  const keys = urls.flatMap((url) => {
    try {
      const [folder, file] = new URL(url).pathname.split("/").filter(Boolean).slice(-2);
      return folder === slug && file ? [`${slug}/${file}`] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(keys)];
}

/** Deletes images an earlier publish uploaded that the post no longer uses, after the site accepted the update. */
async function deleteReplaced(previous: PublishedAssets, current: PublishedAssets, storage: StorageSettings | null, slug: string) {
  if (!storage) return;
  // By key, not URL: after a change of public URL, an unchanged image is uploaded again under the same key.
  const inUse = new Set(storageKeys(Object.values(current), slug));
  const stale = storageKeys(Object.values(previous), slug).filter((key) => !inUse.has(key));
  if (!stale.length) return;
  const client = bucketClient(storage);
  for (const key of stale) await client.fetch(objectUrl(storage, key), { method: "DELETE" }).catch(() => undefined);
}

/**
 * Deletes the images of a post being replaced, before anything else is sent. A failure stops the publish, so the post
 * isn't replaced while its old images stay behind; publishing again deletes the rest. Returns how many were deleted.
 */
async function deleteImages(urls: string[], slug: string, storage: StorageSettings | null) {
  const keys = storage ? storageKeys(urls, slug) : [];
  if (!storage || !keys.length) return 0;
  const client = bucketClient(storage);
  for (const key of keys) {
    const response = await client.fetch(objectUrl(storage, key), { method: "DELETE" });
    // 404: already gone (an earlier attempt that stopped later on).
    if (!response.ok && response.status !== 404)
      throw new Error(`Deleting the old image ${key} from the bucket "${storage.bucket}" failed (HTTP ${response.status}). Nothing was published.`);
  }
  return keys.length;
}

const postUrl = (state: Pick<AgentState, "website">, slug: string) => new URL(`/blog/${slug}`, state.website.websiteUrl).href;
const BLOG_POST_PATH = /^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
function blogSlug(url: string) {
  try {
    return new URL(url).pathname.match(BLOG_POST_PATH)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The posts on the blog an article can replace, one per address: those other articles published from here (newest
 * first), the post this article rewrites, then the blog posts in the site index. A post published from here knows its
 * images (in the product's storage), so they can be deleted; the images of other posts aren't Inkstaff's to delete.
 */
export function mergeTargets(
  article: Pick<AgentArticle, "state">,
  published: { id: string; title: string; publication: Publication }[],
  indexed: { url: string; title: string | null }[],
  storage: StorageSettings | null,
): PublishTarget[] {
  const targets = new Map<string, PublishTarget & { urls: string[] }>();
  for (const { id, title, publication } of published) {
    const urls = Object.values(publication.assets ?? {});
    const known = targets.get(publication.slug);
    if (known) {
      known.articleIds.push(id);
      known.urls.push(...urls);
    } else
      targets.set(publication.slug, {
        slug: publication.slug,
        url: publication.url ?? postUrl(article.state, publication.slug),
        title,
        source: "inkstaff",
        articleIds: [id],
        images: 0,
        updatedAt: publication.updatedAt,
        urls,
      });
  }
  const rewrite = article.state.existingPost;
  if (rewrite && !targets.has(rewrite.slug))
    targets.set(rewrite.slug, { slug: rewrite.slug, url: rewrite.url, title: rewrite.title, source: "rewrite", articleIds: [], images: 0, urls: [] });
  for (const page of [...indexed].sort((a, b) => (a.title ?? a.url).localeCompare(b.title ?? b.url))) {
    const slug = blogSlug(page.url);
    if (slug && !targets.has(slug))
      targets.set(slug, { slug, url: page.url, title: page.title?.trim() || slug, source: "index", articleIds: [], images: 0, urls: [] });
  }
  return [...targets.values()].map(({ urls, ...target }) => ({ ...target, images: storage ? storageKeys(urls, target.slug).length : 0 }));
}

/** The posts on the product's blog this article can replace (mergeTargets). */
export async function publishTargets(article: AgentArticle, storage: StorageSettings | null) {
  const [published, indexed] = await Promise.all([
    publishedArticles(article.productId, article.id),
    indexedBlogPages(article.productId),
  ]);
  return mergeTargets(article, published, indexed, storage);
}

/**
 * Where a publish goes: null for the article's own post (its first publish, or an update once published), or the post
 * it replaces. An article that rewrites a post can only replace that one. A first publish may not land on a post
 * already at its address: it would overwrite the post and leave its images behind.
 */
export function chooseTarget(article: Pick<AgentArticle, "state">, targets: PublishTarget[], replaceSlug: string | null) {
  const { state } = article;
  if (state.publication) {
    if (replaceSlug && replaceSlug !== state.publication.slug)
      throw new Error("This article is already on the blog, so it can only update its own post.");
    return null;
  }
  if (state.existingPost && replaceSlug && replaceSlug !== state.existingPost.slug)
    throw new Error(`This article rewrites ${state.existingPost.url}, so it can only replace that post.`);
  const slug = state.existingPost?.slug ?? replaceSlug;
  if (!slug) {
    const taken = targets.find((t) => t.slug === state.metadata?.slug);
    if (taken)
      throw new Error(`"${taken.title}" is already at /blog/${taken.slug}. Replace that post, or change the slug in the SEO tab.`);
    return null;
  }
  const target = targets.find((t) => t.slug === slug);
  if (!target) throw new Error("That post is no longer on the blog's list. Reload the page and choose again.");
  return target;
}

/**
 * Publishes to the product's blog webhook (publish_articles, then update_article). The first publish creates the post;
 * later ones update it under its slug (the slug is fixed once published). Replacing a post already on the blog (a
 * rewrite, or Publish → Replace) deletes that post's images from the storage first, then uploads this article's and
 * updates the post under its slug. Images go to the product's storage; an article without images publishes without it.
 */
export async function publishAgentArticle(
  article: AgentArticle,
  publishing: PublishingSettings,
  storage: StorageSettings | null,
  replacing?: { slug: string; images: string[] },
): Promise<Publication> {
  const { state } = article;
  if (!state.metadata || !state.sections.length) throw new Error("The article isn't finished yet.");
  const previous = state.publication;
  if (previous && replacing) throw new Error("This article is already on the blog, so it can only update its own post.");
  const slug = previous?.slug ?? replacing?.slug ?? state.existingPost?.slug ?? state.metadata.slug;
  if (replacing) await deleteImages(replacing.images, replacing.slug, storage);
  const assets = await uploadImages(article, storage, slug);
  const markdown = publishMarkdown(state, assets);
  const now = new Date().toISOString();
  const update = !!previous || !!replacing || !!state.existingPost;
  const post = {
    id: article.id,
    title: state.metadata.h1,
    content_markdown: markdown,
    content_html: markdownToHtml(markdown),
    meta_description: state.metadata.metaDescription,
    image_url: state.cover?.assetId ? (assets[state.cover.assetId] ?? null) : null,
    slug,
    tags: [] as string[],
  };
  const payload = update
    ? { event_type: "update_article", timestamp: now, data: { article: post } }
    : { event_type: "publish_articles", timestamp: now, data: { articles: [{ ...post, created_at: now }] } };
  const response = await fetch(publishing.endpointUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${publishing.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`The blog endpoint returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}.`);
  await deleteReplaced(previous?.assets ?? {}, assets, storage, slug);
  return {
    slug,
    url: postUrl(state, slug),
    publishedAt: previous?.publishedAt ?? now,
    updatedAt: now,
    assets,
    response: body.slice(0, 500),
  };
}
