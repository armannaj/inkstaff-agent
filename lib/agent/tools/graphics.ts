import "server-only";
import { z } from "zod";
import { AGENT_MAX_IMAGES, AGENT_MAX_SCREENSHOTS } from "@/lib/config";
import { captureScreenshot, describeImage, drawCover, drawIllustration, drawInfographic, houseStyle, nextImageId } from "../media/images";
import { unsupportedNumbers } from "../content/verify";
import { MediaNotesSchema } from "../schemas";
import { publicUrl } from "../web/url-safety";
import { defineTool, refuse, type AgentTool, type ToolContext } from "./types";
import type { ArticleVideo } from "../types";

/** When the author chose a number of images, no more are placed (the cover isn't counted). */
function overImageLimit({ article }: ToolContext) {
  const limit = article.input.imageCount;
  if (limit === "auto") return null;
  const placed = article.state.images.filter((i) => i.assetId).length;
  return placed >= limit ? `The author asked for ${limit} image${limit === 1 ? "" : "s"} in the article, and ${placed} are placed. Replace or remove one instead.` : null;
}

const imageList = ({ article }: ToolContext) => ({
  images: article.state.images.map(({ id, sectionId, kind, subject, altText, assetId, error }) => ({
    id,
    sectionId,
    kind,
    subject,
    altText,
    ok: !!assetId,
    error,
  })),
  cover: article.state.cover && { headline: article.state.cover.headline, ok: !!article.state.cover.assetId, textIssue: article.state.cover.textIssue },
  videos: article.state.videos.map(({ id, sectionId, title, channel, url }) => ({ id, sectionId, title, channel, url })),
  imageLimit: article.input.imageCount,
});

export const listImages = defineTool({
  name: "list_images",
  description: "The images and videos placed in the article so far, and the cover.",
  schema: z.object({}),
  async run(_args, ctx) {
    return imageList(ctx);
  },
});

export const inspectImage = defineTool({
  name: "inspect_image",
  description:
    "Look at an image (an img-N ID, or \"cover\") and get a description: what it shows, visible text, and whether a screenshot is an error page, bot check or cookie wall.",
  schema: z.object({ imageId: z.string() }),
  async run({ imageId }, { article, providers, assets }) {
    const assetId = imageId === "cover" ? article.state.cover?.assetId : article.state.images.find((i) => i.id === imageId)?.assetId;
    if (!assetId) return refuse(`There is no generated image "${imageId}".`);
    const asset = await assets.get(assetId);
    if (!asset) return refuse("The image file is missing.");
    return { imageId, description: await describeImage(providers, asset) };
  },
});

const ImageReviewSchema = z.object({
  relevance: z.number().min(1).max(5),
  quality: z.number().min(1).max(5),
  problems: z.array(z.string()),
  recommendation: z.enum(["keep", "regenerate", "replace_with_screenshot", "replace_with_illustration", "remove"]),
  notes: z.string(),
});

/** Judges one image against the section it sits in, with a rubric. The Reviewer's tool: image review is its job. */
export const reviewImage = defineTool({
  name: "review_image",
  description:
    "Review one image (img-N or \"cover\") in context: relevance to its section (1-5), visual quality (1-5), concrete problems (error page, cookie wall, wrong product or page, cut off, blurry, lettering in an illustration, misspelled cover headline, alt text that doesn't match), and a recommendation: keep, regenerate, replace_with_screenshot, replace_with_illustration or remove.",
  schema: z.object({ imageId: z.string() }),
  async run({ imageId }, { article, providers, assets, log }) {
    const { state } = article;
    const image = imageId === "cover" ? null : state.images.find((i) => i.id === imageId);
    const assetId = imageId === "cover" ? state.cover?.assetId : image?.assetId;
    if (!assetId) return refuse(`There is no generated image "${imageId}".`);
    const asset = await assets.get(assetId);
    if (!asset) return refuse("The image file is missing.");
    const section = image && state.sections.find((s) => s.id === image.sectionId);
    const item = image && state.plan?.sections.find((p) => p.id === image.sectionId)?.item;
    const context =
      imageId === "cover"
        ? `This is the article's cover. Article title: "${state.metadata?.h1 ?? ""}". The headline drawn on it must read exactly: "${state.cover?.headline}".`
        : `This ${image!.kind} sits in the section "${section?.heading ?? image!.sectionId}"${item ? ` about ${item}` : ""}. ${image!.kind === "screenshot" ? `It should show ${image!.subject}.` : `It was drawn to show: ${image!.subject}.`} Alt text: "${image!.altText}". Section text: ${section?.markdown.slice(0, 1500) ?? ""}`;
    const raw = await providers.vision(
      `data:${asset.mimeType};base64,${asset.base64}`,
      `You review images for a blog article. ${context}
Return ONLY JSON: {"relevance": 1-5, "quality": 1-5, "problems": [strings], "recommendation": "keep" | "regenerate" | "replace_with_screenshot" | "replace_with_illustration" | "remove", "notes": string}.
relevance: does it help a reader of this section (5 = clearly shows what the section is about). quality: is it sharp, complete and professional. A screenshot of an error page, bot check, cookie or login wall, a blank or half-loaded page, or the wrong product is quality 1. An illustration with any lettering is a problem. Describe only what is visible.`,
    );
    let review: z.infer<typeof ImageReviewSchema>;
    try {
      review = ImageReviewSchema.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
    } catch {
      return { imageId, review: "The image check didn't return a usable answer.", description: raw.slice(0, 600) };
    }
    log(`${imageId}: relevance ${review.relevance}/5, quality ${review.quality}/5 → ${review.recommendation}`);
    return { imageId, ...review };
  },
});

const sectionExists = ({ article }: ToolContext, sectionId: string) => article.state.sections.some((s) => s.id === sectionId);

const takeScreenshot = defineTool({
  name: "take_screenshot",
  description: `Screenshot a website (1280×720) and place it in a section, e.g. a listed product's home or pricing page. Check it with inspect_image: remove it if it shows an error page, bot check or cookie wall. Limit ${AGENT_MAX_SCREENSHOTS} per article.`,
  schema: z.object({ sectionId: z.string(), url: z.string().url(), altText: z.string() }),
  async run({ sectionId, url, altText }, ctx) {
    const { article, providers, assets, log } = ctx;
    if (!sectionExists(ctx, sectionId)) return refuse(`There is no section "${sectionId}".`);
    if (article.state.usage.screenshots >= AGENT_MAX_SCREENSHOTS) return refuse("No screenshots left for this article.");
    const overLimit = overImageLimit(ctx);
    if (overLimit) return refuse(overLimit);
    try {
      publicUrl(url);
    } catch {
      return refuse("Only public http(s) addresses can be captured.");
    }
    article.state.usage.screenshots++;
    const image = await captureScreenshot(article, providers, assets, { id: nextImageId(article.state.images), sectionId, altText, url });
    article.state.images.push(image);
    article.state.changedSinceReview = true;
    if (image.assetId) log(`Took a screenshot of ${url} (${image.id})`);
    return image.assetId ? { placed: image.id, sectionId } : refuse(`The screenshot failed: ${image.error}`);
  },
});

const generateIllustration = defineTool({
  name: "generate_illustration",
  description: `Draw a wordless illustration (16:9) in the article's house style and place it in a section. Describe a concrete scene; images with any lettering are rejected. style (a technique, drawn in the house palette) is used only when the author left the image style to you. Limit ${AGENT_MAX_IMAGES} generated images per article, covers included.`,
  schema: z.object({
    sectionId: z.string(),
    scene: z.string().min(10),
    altText: z.string(),
    style: z.string().optional().describe("A technique, e.g. isometric scene, close-up still life, diagram-like sketch. Leave out for the house style's own."),
  }),
  async run({ sectionId, scene, altText, style }, ctx) {
    const { article, providers, assets, log } = ctx;
    if (!sectionExists(ctx, sectionId)) return refuse(`There is no section "${sectionId}".`);
    if (article.state.usage.images >= AGENT_MAX_IMAGES) return refuse("No image generations left for this article.");
    const overLimit = overImageLimit(ctx);
    if (overLimit) return refuse(overLimit);
    article.state.usage.images++;
    const image = await drawIllustration(article, providers, assets, { id: nextImageId(article.state.images), sectionId, altText, scene, style });
    if (!image.assetId) return refuse(image.error ?? "The illustration failed.");
    article.state.images.push(image);
    article.state.changedSinceReview = true;
    log(`Drew an illustration for ${sectionId}`);
    return { placed: image.id, sectionId, altText: image.altText };
  },
});

const generateCover = defineTool({
  name: "generate_cover",
  description:
    "Draw the cover image: a short headline (3-8 words, the only text in it) in the product's cover style, plus one simple topic motif. The headline is read back; a misspelled one is redrawn once.",
  schema: z.object({
    headline: z.string().min(3).max(80),
    artDirection: z.string().describe("One or two sentences: a single simple motif for the topic."),
  }),
  async run({ headline, artDirection }, { article, providers, assets, log }) {
    if (article.state.usage.images >= AGENT_MAX_IMAGES - 1) return refuse("No image generations left for a cover.");
    article.state.usage.images += 2;
    const cover = await drawCover(article, providers, assets, {
      headline,
      artDirection,
      style: houseStyle(article).id,
    });
    article.state.cover = cover;
    article.state.changedSinceReview = true;
    log(`Drew the cover "${headline}"${cover.textIssue ? " (headline came out wrong)" : ""}`);
    return { ok: !cover.textIssue, ...(cover.textIssue ? { textIssue: cover.textIssue } : {}) };
  },
});

const regenerateImage = defineTool({
  name: "regenerate_image",
  description:
    "Replace an image in place (same position): a screenshot is retaken, optionally of another URL; an illustration is redrawn, optionally with a new scene. Counts against the screenshot or image limit.",
  schema: z.object({
    imageId: z.string(),
    url: z.string().url().optional().describe("Screenshots: another page to capture."),
    scene: z.string().optional().describe("Illustrations: a new scene."),
    altText: z.string().optional(),
  }),
  async run({ imageId, url, scene, altText }, { article, providers, assets, log }) {
    const { state } = article;
    const image = state.images.find((i) => i.id === imageId);
    if (!image) return refuse(`There is no image "${imageId}".`);
    const alt = altText ?? image.altText;
    let next;
    if (image.kind === "screenshot") {
      if (state.usage.screenshots >= AGENT_MAX_SCREENSHOTS) return refuse("No screenshots left for this article.");
      try {
        if (url) publicUrl(url);
      } catch {
        return refuse("Only public http(s) addresses can be captured.");
      }
      state.usage.screenshots++;
      next = await captureScreenshot(article, providers, assets, { id: image.id, sectionId: image.sectionId, altText: alt, url: url ?? image.subject }, true);
    } else {
      if (state.usage.images >= AGENT_MAX_IMAGES) return refuse("No image generations left for this article.");
      state.usage.images++;
      next =
        image.kind === "infographic" && image.infographic
          ? await drawInfographic(article, providers, assets, { id: image.id, sectionId: image.sectionId, altText: alt, spec: image.infographic, style: image.style })
          : await drawIllustration(article, providers, assets, { id: image.id, sectionId: image.sectionId, altText: alt, scene: scene ?? image.subject, style: image.style });
    }
    if (!next.assetId) return refuse(`${next.error ?? "It failed"}; the current image was kept.`);
    state.images = state.images.map((i) => (i.id === imageId ? next : i));
    state.changedSinceReview = true;
    log(`Regenerated ${imageId}`);
    return { regenerated: imageId };
  },
});

const createInfographic = defineTool({
  name: "create_infographic",
  description: `Draw an infographic (16:9) in the article's house style with exactly the text you give: a title and 2-8 items. Its text is read back from the image and must match; numbers in it must come from the article or the pages read. Counts as a generated image (limit ${AGENT_MAX_IMAGES}).`,
  schema: z.object({
    sectionId: z.string(),
    title: z.string().min(3).max(80),
    points: z.array(z.object({ label: z.string().min(1).max(60), detail: z.string().max(120).optional() })).min(2).max(8),
    altText: z.string(),
    style: z.string().optional().describe("A technique, drawn in the house palette; used only when the author left the image style to you."),
  }),
  async run({ sectionId, title, points, altText, style }, ctx) {
    const { article, providers, assets, log } = ctx;
    const { state, input } = article;
    if (!sectionExists(ctx, sectionId)) return refuse(`There is no section "${sectionId}".`);
    if (state.usage.images >= AGENT_MAX_IMAGES) return refuse("No image generations left for this article.");
    const overLimit = overImageLimit(ctx);
    if (overLimit) return refuse(overLimit);
    const text = [title, ...points.flatMap((p) => [p.label, p.detail ?? ""])].join(". ");
    const evidence = [...state.sources.map((s) => s.content), ...state.sections.map((s) => s.markdown), input.ownerMaterial ?? "", state.website.productDescription].join("\n");
    const invented = unsupportedNumbers([{ id: sectionId, markdown: text }], evidence).flatMap((u) => u.missing);
    if (invented.length) return refuse(`These numbers appear nowhere in the article or the pages read: ${invented.join(", ")}.`);
    state.usage.images++;
    const image = await drawInfographic(article, providers, assets, { id: nextImageId(state.images), sectionId, altText, spec: { title, points }, style });
    if (!image.assetId) return refuse(image.error ?? "The infographic failed.");
    state.images.push(image);
    state.changedSinceReview = true;
    log(`Drew an infographic "${title}" for ${sectionId}`);
    return { placed: image.id, sectionId };
  },
});

type YoutubeItem = {
  type?: string;
  url?: string;
  title?: string;
  channel_name?: string;
  duration_time_seconds?: number;
  views_count?: number;
  publication_date?: string;
  timestamp?: string;
};
/** The video entries of the YouTube searches made for this article, by URL. */
export function searchedVideos(cache: Record<string, unknown> = {}) {
  const videos = new Map<string, YoutubeItem>();
  for (const response of Object.values(cache)) {
    const items = (response as { items?: YoutubeItem[] })?.items ?? [];
    for (const item of items) if (item.type === "youtube_video" && item.url) videos.set(item.url.split("&")[0], item);
  }
  return videos;
}

const addVideo = defineTool({
  name: "add_video",
  description: "Place a planned YouTube video (a URL from this article's YouTube searches) in its section, with one sentence on why it helps the reader there. It is published as an embedded player at the end of the section.",
  schema: z.object({ sectionId: z.string(), url: z.string().url(), reason: z.string() }),
  async run({ sectionId, url, reason }, ctx) {
    const { article, log } = ctx;
    const { state } = article;
    if (!sectionExists(ctx, sectionId)) return refuse(`There is no section "${sectionId}".`);
    const video = searchedVideos(state.youtubeCache).get(url.split("&")[0]);
    if (!video) return refuse("Only videos from this article's YouTube searches can be placed.");
    if (state.videos.some((v) => v.url === video.url)) return refuse("This video is already placed.");
    const placed: ArticleVideo = {
      id: `vid-${Math.max(0, ...state.videos.map((v) => Number(v.id.slice(4)) || 0)) + 1}`,
      sectionId,
      url: video.url!,
      title: video.title ?? video.url!,
      channel: video.channel_name ?? "",
      durationSeconds: video.duration_time_seconds,
      views: video.views_count,
      publishedAt: video.publication_date ?? video.timestamp,
      reason,
    };
    state.videos.push(placed);
    state.changedSinceReview = true;
    log(`Placed the video "${placed.title}" in ${sectionId}`);
    return { placed: placed.id, sectionId };
  },
});

const removeVideo = defineTool({
  name: "remove_video",
  description: "Remove a video from the article.",
  schema: z.object({ videoId: z.string() }),
  async run({ videoId }, { article, log }) {
    const before = article.state.videos.length;
    article.state.videos = article.state.videos.filter((v) => v.id !== videoId);
    if (article.state.videos.length === before) return refuse(`There is no video "${videoId}".`);
    article.state.changedSinceReview = true;
    log(`Removed ${videoId}`);
    return { removed: videoId };
  },
});

const removeImage = defineTool({
  name: "remove_image",
  description: "Remove an image from the article.",
  schema: z.object({ imageId: z.string() }),
  async run({ imageId }, { article, log }) {
    const before = article.state.images.length;
    article.state.images = article.state.images.filter((i) => i.id !== imageId);
    if (article.state.images.length === before) return refuse(`There is no image "${imageId}".`);
    article.state.changedSinceReview = true;
    log(`Removed ${imageId}`);
    return { removed: imageId };
  },
});

const submitMedia = defineTool({
  name: "submit_media",
  description: "Hand the article's media to the Director. Ends your work. The article needs a cover. Say in notes which planned media couldn't be made, and why.",
  schema: MediaNotesSchema,
  submit: true,
  async run(notes, { article, log }) {
    if (!article.state.cover?.assetId) return refuse("Generate the cover first.");
    article.state.mediaNotes = notes;
    log(`Submitted ${article.state.images.filter((i) => i.assetId).length} images and the cover`, "submit");
    return { submitted: true };
  },
});

export const graphicsTools = (): AgentTool[] => [
  listImages,
  inspectImage,
  takeScreenshot,
  generateIllustration,
  createInfographic,
  regenerateImage,
  generateCover,
  removeImage,
  addVideo,
  removeVideo,
  submitMedia,
];
