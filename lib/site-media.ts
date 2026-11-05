import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { products } from "@/db/schema";
import { getAgentProviders } from "@/lib/agent/providers";
import { assetId, describeImage } from "@/lib/agent/media/images";
import { deleteProductAssets, saveProductAsset } from "@/lib/agent/store";
import { fetchPublicText } from "@/lib/agent/web/fetch-page";
import { findPageMedia } from "@/lib/agent/web/page-media";
import type { ProductMedia, SiteMedia } from "@/lib/agent/types";

/** Sections of the home page (an example, a demo) captured as screenshots, besides its first screen. */
const MAX_SECTION_SHOTS = 2;

/** A YouTube video's title and channel, from YouTube's public oEmbed endpoint. */
async function youtubeDetails(url: string) {
  try {
    const { text } = await fetchPublicText(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    const data = z.object({ title: z.string(), author_name: z.string().optional() }).parse(JSON.parse(text));
    return { title: data.title, channel: data.author_name };
  } catch {
    return null;
  }
}

/**
 * Captures what the product's home page offers to show the product: its first screen and its demo sections as
 * screenshots, each described (the agents that plan the article can't see images), and the demos and videos it embeds
 * or links. Saved on the product in place of the previous capture; each new article gets a copy. What can't be captured
 * is listed in `errors`, and the rest is kept.
 */
export async function captureSiteMedia(productId: number, pageUrl: string, html: string): Promise<SiteMedia> {
  const capturedAt = new Date().toISOString();
  const providers = getAgentProviders(() => undefined);
  const errors: string[] = [];
  const found = findPageMedia(html, pageUrl);
  const sections = found.filter((media) => media.selector).slice(0, MAX_SECTION_SHOTS);

  const shoot = async (name: string, url: string, selector?: string) => {
    if (!providers.screenshot) return null;
    try {
      // A section is captured by its selector: browsers abort navigation to some #fragment addresses.
      const shot = await providers.screenshot(selector ? url.split("#")[0] : url, { fresh: true, selector });
      const description = await describeImage(providers, shot).catch(() => "");
      const id = assetId(`product${productId}`, name);
      await saveProductAsset(id, productId, shot);
      return { assetId: id, description };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message.slice(0, 200) : "the screenshot failed"}`);
      return null;
    }
  };
  if (!providers.screenshot) errors.push("No screenshots: SCREENSHOTENGINE_API_KEY is not set.");
  const [home, ...sectionShots] = await Promise.all([
    shoot("home", pageUrl),
    ...sections.map((media, i) => shoot(`section${i + 1}`, media.url, media.selector)),
  ]);

  const items: ProductMedia[] = [];
  const nextId = () => `pm-${items.length + 1}`;
  if (home)
    items.push({
      id: nextId(),
      kind: "screenshot",
      url: pageUrl,
      label: "The home page's first screen",
      description: home.description,
      assetId: home.assetId,
      capturedAt,
    });
  for (const media of found) {
    const shot = media.selector ? sectionShots[sections.indexOf(media)] : null;
    const youtube = media.host === "youtube" ? await youtubeDetails(media.url) : null;
    items.push({
      id: nextId(),
      kind: media.kind,
      url: media.url,
      label: youtube?.title || media.label,
      host: media.host,
      description: shot?.description ? `${shot.description}\nThe page's text there: ${media.context}` : media.context,
      ...(shot ? { assetId: shot.assetId } : {}),
      ...(media.selector ? { selector: media.selector } : {}),
      ...(media.host === "youtube" ? { embeddable: true } : {}),
      ...(youtube?.channel ? { channel: youtube.channel } : {}),
      capturedAt,
    });
  }

  const siteMedia: SiteMedia = { pageUrl, capturedAt, items, errors };
  await getDb().update(products).set({ siteMedia }).where(eq(products.id, productId));
  await deleteProductAssets(productId, items.flatMap((item) => (item.assetId ? [item.assetId] : [])));
  return siteMedia;
}
