import "server-only";
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import sharp from "sharp";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { youtubeVideoId } from "../web/youtube";
import rehypeStringify from "rehype-stringify";
import type { PublishingSettings, StorageSettings } from "@/lib/schemas";
import { getAsset } from "../store";
import type { AgentArticle, AgentState, Publication } from "../types";

/** Public URLs of uploaded images, by asset ID. */
type PublishedAssets = Record<string, string>;
const altText = (value: string) => value.replace(/[[\]\\\r\n]/g, " ").trim();

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The body the site receives: sections with their images after the first paragraph, then an older article's separate
 * FAQ, if it has one. No H1, no cover.
 */
export function publishMarkdown(state: Pick<AgentState, "sections" | "images" | "videos" | "faq">, assets: PublishedAssets) {
  const sections = state.sections.map((section) => {
    const images = state.images.filter((i) => i.sectionId === section.id && i.assetId && assets[i.assetId]);
    const blocks = section.markdown.split(/\n{2,}/);
    const at = blocks.findIndex((block) => !/^\s*([-*+|>]|\d+\.|#)/.test(block));
    if (images.length)
      blocks.splice(at < 0 ? blocks.length : at + 1, 0, ...images.map((i) => `![${altText(i.altText)}](${assets[i.assetId!]})`));
    // Videos at the end of their section as an embedded player, for sites whose Markdown renderer passes HTML through
    // (content_html has it too). A URL without a recognizable video ID stays a link.
    const videos = (state.videos ?? [])
      .filter((v) => v.sectionId === section.id)
      .map((v) => {
        const id = youtubeVideoId(v.url);
        return id
          ? `<iframe width="100%" style="aspect-ratio: 16 / 9;" src="https://www.youtube.com/embed/${id}" title="${attribute(v.title)}" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`
          : `▶ [${altText(v.title)}](${v.url})${v.channel ? ` · ${altText(v.channel)}` : ""}`;
      });
    return `## ${section.heading}\n\n${[...blocks, ...videos].join("\n\n")}`;
  });
  const faq = state.faq.length
    ? [`## Frequently asked questions\n\n${state.faq.map((f) => `### ${f.question}\n\n${f.answer}`).join("\n\n")}`]
    : [];
  return [...sections, ...faq].join("\n\n");
}
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
    ...(state.cover?.assetId ? [{ assetId: state.cover.assetId, name: "cover", width: 1600 }] : []),
    ...state.images.flatMap((i) => (i.assetId ? [{ assetId: i.assetId, name: i.altText, width: 1200 }] : [])),
  ];
  const previous = state.publication?.assets ?? {};
  const assets: PublishedAssets = {};
  let client: AwsClient | undefined;
  for (const { assetId, name, width } of wanted) {
    const asset = await getAsset(assetId);
    if (!asset) continue;
    if (!storage) throw new Error("Set up image storage for this product first (Products → Image storage).");
    const body = await sharp(Buffer.from(asset.base64, "base64")).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
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

/** Deletes images an earlier publish uploaded that the post no longer uses, after the site accepted the update. */
async function deleteReplaced(previous: PublishedAssets, current: PublishedAssets, storage: StorageSettings | null) {
  if (!storage) return;
  const inUse = new Set(Object.values(current));
  const prefix = `${storage.publicUrl}/`;
  const stale = [...new Set(Object.values(previous))].filter((url) => !inUse.has(url) && url.startsWith(prefix));
  if (!stale.length) return;
  const client = bucketClient(storage);
  for (const url of stale)
    await client.fetch(objectUrl(storage, url.slice(prefix.length)), { method: "DELETE" }).catch(() => undefined);
}

/**
 * Publishes to the product's blog webhook (publish_articles, then update_article). The first publish creates the post;
 * later ones, and a rewrite of an existing post, update it under its slug (the slug is fixed once published). Images
 * go to the product's storage first; an article without images publishes without it.
 */
export async function publishAgentArticle(
  article: AgentArticle,
  publishing: PublishingSettings,
  storage: StorageSettings | null,
): Promise<Publication> {
  const { state } = article;
  if (!state.metadata || !state.sections.length) throw new Error("The article isn't finished yet.");
  const previous = state.publication;
  const slug = previous?.slug ?? state.existingPost?.slug ?? state.metadata.slug;
  const assets = await uploadImages(article, storage, slug);
  const markdown = publishMarkdown(state, assets);
  const now = new Date().toISOString();
  const update = !!previous || !!state.existingPost;
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
  await deleteReplaced(previous?.assets ?? {}, assets, storage);
  return {
    slug,
    url: new URL(`/blog/${slug}`, state.website.websiteUrl).href,
    publishedAt: previous?.publishedAt ?? now,
    updatedAt: now,
    assets,
    response: body.slice(0, 500),
  };
}
