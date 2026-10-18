"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasDataForSeo } from "@/lib/dataforseo";
import {
  acquireIdle,
  articleView,
  commitAgentArticle,
  createAgentArticle,
  dbAssets,
  deleteAgentArticle,
  getAgentArticle,
  getAgentArticleView,
  pollAgentArticle,
  productCoverStyle,
  publishingSettings,
  releaseLease,
  requeue,
  setControl,
} from "@/lib/agent/store";
import { kickRunner } from "@/lib/agent/runner";
import { cleanLinks } from "@/lib/agent/content/links";
import { captureScreenshot, drawCover, drawIllustration, drawInfographic, houseStyle } from "@/lib/agent/media/images";
import { getAgentProviders } from "@/lib/agent/providers";
import { publishAgentArticle } from "@/lib/agent/publish/publish";
import { publicUrl } from "@/lib/agent/web/url-safety";
import type { AgentArticle } from "@/lib/agent/types";

type ActionResult<T> = { data?: T; error?: string };
async function action<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { data: await run() };
  } catch (error) {
    console.error("Blog agent action failed", error);
    return {
      error:
        error instanceof Error && !/sqlite|query:|password/i.test(error.message)
          ? error.message.slice(0, 500)
          : "The change could not be saved. Check the server log.",
    };
  }
}
const idSchema = z.uuid();
const versionSchema = z.number().int().nonnegative();
const view = (article: AgentArticle) => articleView(article);

/** Runs an editor change under the article's lease; failures release it. Costs are recorded under "editing". */
async function edit(id: string, version: number, change: (article: AgentArticle, charge: (usd: number | null) => void) => Promise<void>) {
  const { article, token } = await acquireIdle(idSchema.parse(id), versionSchema.parse(version));
  if (article.status === "queued" || article.status === "running") {
    await releaseLease(article.id, token);
    throw new Error("The agents are working on this article. Pause it first.");
  }
  try {
    const cost = article.state.cost;
    await change(article, (usd) => {
      cost.calls++;
      if (usd == null) cost.unpricedCalls++;
      else {
        cost.totalUsd += usd;
        cost.byAgent.editing = (cost.byAgent.editing ?? 0) + usd;
      }
    });
    return view(await commitAgentArticle(article, token, {}));
  } catch (error) {
    await releaseLease(article.id, token);
    throw error;
  }
}

export async function createAgentArticleAction(input: unknown) {
  return action(async () => {
    if (!process.env.OPENROUTER_API_KEY || !hasDataForSeo())
      throw new Error("Set OPENROUTER_API_KEY and DFS_AUTH (or DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) before generating an article.");
    const id = await createAgentArticle(input);
    kickRunner();
    revalidatePath("/");
    return id;
  });
}

export async function getAgentArticleAction(id: string) {
  return action(async () => {
    const article = await getAgentArticleView(idSchema.parse(id));
    if (!article) throw new Error("Article not found.");
    return article;
  });
}

/** For a page watching a running article: new log lines and the status; the rest of the view only when asked for. */
export async function pollAgentArticleAction(id: string, since: string, version: number, withView: boolean) {
  return action(async () => {
    const poll = await pollAgentArticle(idSchema.parse(id), z.string().max(40).parse(since), versionSchema.parse(version), withView);
    if (!poll) throw new Error("Article not found.");
    return poll;
  });
}

/** Pause or stop: a running article stops at the end of its current step; a queued one right away. */
export async function controlAgentAction(id: string, control: "pause" | "stop") {
  return action(async () => {
    const article = await getAgentArticle(idSchema.parse(id));
    if (!article) throw new Error("Article not found.");
    if (article.status === "running") await setControl(article.id, control);
    else if (article.status === "queued") {
      const { token } = await acquireIdle(article.id, article.version);
      await commitAgentArticle(article, token, { status: control === "pause" ? "paused" : "needs_review" });
    }
    const next = await getAgentArticleView(article.id);
    return next!;
  });
}

export async function resumeAgentAction(id: string) {
  return action(async () => {
    const article = await requeue(idSchema.parse(id));
    kickRunner();
    return view(article);
  });
}

/** A note to the agents (paused or finished article): the Director reads it and sends the work where it belongs. */
export async function sendAgentNoteAction(id: string, text: string) {
  return action(async () => {
    const note = z.string().trim().min(3).max(4000).parse(text);
    const article = await requeue(idSchema.parse(id), (state) => ({
      ...state,
      humanNotes: [...state.humanNotes, { at: new Date().toISOString(), text: note, handled: false }],
      timeline: [...state.timeline, { at: new Date().toISOString(), agent: "human", kind: "note", text: note }],
      outcome: undefined,
    }));
    kickRunner();
    return view(article);
  });
}

const EditsSchema = z.object({
  sections: z
    .array(z.object({ id: z.string(), heading: z.string().trim().min(1).max(300), markdown: z.string().max(60_000) }))
    .min(1),
  metadata: z.object({
    h1: z.string().trim().min(3).max(200),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    metaDescription: z.string().max(300),
    excerpt: z.string().max(1000),
  }),
});
/** Manual edits of sections and SEO fields. Links are checked as for the agents; a published slug can't change. */
export async function saveAgentEditsAction(id: string, version: number, input: unknown) {
  return action(() =>
    edit(id, version, async (article) => {
      const { sections, metadata } = EditsSchema.parse(input);
      const { state } = article;
      if (new Set(sections.map((s) => s.id)).size !== sections.length) throw new Error("Section IDs must be unique.");
      const edited = sections.map((s) => ({ ...s, listItems: state.sections.find((o) => o.id === s.id)?.listItems ?? [] }));
      state.sections = cleanLinks(edited, state, article.input).sections;
      state.images = state.images.filter((i) => state.sections.some((s) => s.id === i.sectionId));
      const fixedSlug = state.publication?.slug ?? state.existingPost?.slug;
      state.metadata = { ...state.metadata!, ...metadata, slug: fixedSlug ?? metadata.slug };
      state.changedSinceReview = true;
      state.timeline.push({ at: new Date().toISOString(), agent: "human", kind: "note", text: "Edited the article" });
    }),
  );
}

/** Retake a screenshot (optionally of another page) or redraw an illustration (optionally another scene). */
export async function regenerateAgentImageAction(id: string, version: number, imageId: string, subject?: string) {
  return action(() =>
    edit(id, version, async (article, charge) => {
      const image = article.state.images.find((i) => i.id === imageId);
      if (!image) throw new Error("That image no longer exists.");
      if (image.kind !== "screenshot") article.state.website.coverStyle = await productCoverStyle(article.productId);
      const providers = getAgentProviders(({ usd }) => charge(usd));
      const next =
        image.kind === "screenshot"
          ? await captureScreenshot(article, providers, dbAssets, { ...image, url: subject ? publicUrl(subject).href : image.subject }, true)
          : image.kind === "infographic" && image.infographic
            ? await drawInfographic(article, providers, dbAssets, { ...image, spec: image.infographic })
            : await drawIllustration(article, providers, dbAssets, { ...image, scene: subject?.trim() || image.subject });
      if (!next.assetId) throw new Error(next.error ?? "The new image failed; the current one was kept.");
      article.state.images = article.state.images.map((i) => (i.id === imageId ? next : i));
    }),
  );
}

export async function removeAgentImageAction(id: string, version: number, imageId: string) {
  return action(() =>
    edit(id, version, async (article) => {
      article.state.images = article.state.images.filter((i) => i.id !== imageId);
    }),
  );
}

export async function removeAgentVideoAction(id: string, version: number, videoId: string) {
  return action(() =>
    edit(id, version, async (article) => {
      article.state.videos = article.state.videos.filter((v) => v.id !== videoId);
    }),
  );
}

export async function regenerateAgentCoverAction(
  id: string,
  version: number,
  options: { headline?: string; artDirection?: string },
) {
  return action(() =>
    edit(id, version, async (article, charge) => {
      const current = article.state.cover;
      // The product's style as saved now, so a style chosen after the article was written applies on regeneration.
      article.state.website.coverStyle = await productCoverStyle(article.productId);
      const headline = options.headline?.trim() || current?.headline || article.state.metadata?.h1;
      if (!headline) throw new Error("Give the cover a headline.");
      article.state.cover = await drawCover(article, getAgentProviders(({ usd }) => charge(usd)), dbAssets, {
        headline,
        artDirection: options.artDirection?.trim() || current?.artDirection || "a simple motif for the topic",
        style: houseStyle(article).id,
      });
    }),
  );
}

export async function publishAgentAction(id: string, version: number) {
  return action(async () => {
    const { article, token } = await acquireIdle(idSchema.parse(id), versionSchema.parse(version));
    try {
      if (article.status === "queued" || article.status === "running")
        throw new Error("The agents are still working on this article.");
      const product = await publishingSettings(article.productId);
      if (!product?.publishing) throw new Error("Set up publishing for this product first (Products → Publishing).");
      const publication = await publishAgentArticle(article, product.publishing, product.storage);
      revalidatePath("/");
      return view(
        await commitAgentArticle(article, token, {
          state: { ...article.state, publication },
          ...(article.state.publication ? {} : { publishedAt: new Date(publication.publishedAt) }),
        }),
      );
    } catch (error) {
      await releaseLease(article.id, token);
      throw error;
    }
  });
}

export async function deleteAgentArticleAction(id: string) {
  return action(async () => {
    if (!(await deleteAgentArticle(idSchema.parse(id))))
      throw new Error("The agents are working on this article right now. Pause it, then delete it.");
    revalidatePath("/");
    return true;
  });
}
