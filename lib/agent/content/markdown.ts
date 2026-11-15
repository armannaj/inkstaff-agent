import { youtubeVideoId } from "../web/youtube";
import type { AgentState } from "../types";

/** Where each uploaded image is, by asset ID: its public URL when publishing. */
export type PlacedAssets = Record<string, string>;
const altText = (value: string) => value.replace(/[[\]\\\r\n]/g, " ").trim();
const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * A section as published: its heading as an H2, then its body. The first section may have no heading (""): it is then
 * the article's opening, published directly under the title.
 */
export const sectionMarkdown = (heading: string, body: string) => (heading.trim() ? `## ${heading.trim()}\n\n${body}` : body);
/** What a section is called in logs and messages: its heading, or "Opening" for the opening without one. */
export const sectionLabel = (section: { heading: string }) => section.heading.trim() || "Opening";

/**
 * Each section as the site receives it: its heading, its text with its images after the first paragraph, and its
 * videos at the end as an embedded player (for sites whose Markdown renderer passes HTML through; content_html has
 * it too). A video URL without a recognizable ID stays a link. Only images found in `assets` are placed.
 */
export function publishedSections(state: Pick<AgentState, "sections" | "images" | "videos">, assets: PlacedAssets) {
  return state.sections.map((section) => {
    const images = state.images.filter((i) => i.sectionId === section.id && i.assetId && assets[i.assetId]);
    const blocks = section.markdown.split(/\n{2,}/);
    const at = blocks.findIndex((block) => !/^\s*([-*+|>]|\d+\.|#)/.test(block));
    if (images.length)
      blocks.splice(at < 0 ? blocks.length : at + 1, 0, ...images.map((i) => `![${altText(i.altText)}](${assets[i.assetId!]})`));
    const videos = (state.videos ?? [])
      .filter((v) => v.sectionId === section.id)
      .map((v) => {
        const id = youtubeVideoId(v.url);
        return id
          ? `<iframe width="100%" style="aspect-ratio: 16 / 9;" src="https://www.youtube.com/embed/${id}" title="${attribute(v.title)}" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`
          : `▶ [${altText(v.title)}](${v.url})${v.channel ? ` · ${altText(v.channel)}` : ""}`;
      });
    return { id: section.id, markdown: sectionMarkdown(section.heading, [...blocks, ...videos].join("\n\n")) };
  });
}
/** An older article's separate FAQ, published after the last section; "" when it has none. */
const faqMarkdown = (faq: AgentState["faq"]) =>
  faq.length ? `## Frequently asked questions\n\n${faq.map((f) => `### ${f.question}\n\n${f.answer}`).join("\n\n")}` : "";

/** The body the site receives: the sections as published, then an older article's separate FAQ. No H1, no cover. */
export function publishMarkdown(state: Pick<AgentState, "sections" | "images" | "videos" | "faq">, assets: PlacedAssets) {
  return [...publishedSections(state, assets).map((s) => s.markdown), faqMarkdown(state.faq)].filter(Boolean).join("\n\n");
}

/**
 * The page as its reader gets it, for the Reviewer: the title, then the published body, with each image where it is
 * placed, named by its ID. A comment before each section gives its ID (for issues); the comments aren't on the page.
 */
export function pageAsPublished(state: Pick<AgentState, "metadata" | "plan" | "sections" | "images" | "videos" | "faq">) {
  const title = state.metadata?.h1 || state.plan?.h1;
  const placed = Object.fromEntries(state.images.flatMap((i) => (i.assetId ? [[i.assetId, i.id]] : [])));
  return [
    title ? `# ${title}` : "",
    ...publishedSections(state, placed).map((s) => `<!-- section ${s.id} -->\n${s.markdown}`),
    faqMarkdown(state.faq),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The whole article as Markdown: title, sections, then an older article's separate FAQ, if it has one. */
export function articleMarkdown(state: Pick<AgentState, "metadata" | "plan" | "sections" | "faq">) {
  const title = state.metadata?.h1 || state.plan?.h1;
  return [
    title ? `# ${title}` : "",
    ...state.sections.map((s) => sectionMarkdown(s.heading, s.markdown)),
    faqMarkdown(state.faq),
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function wordCount(markdown: string) {
  return markdown
    .replace(/\[[^\]]*\]\([^)]*\)/g, (s) => s.slice(1, s.indexOf("]")))
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}
