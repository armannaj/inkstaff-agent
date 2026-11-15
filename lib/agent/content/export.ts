import { publishMarkdown } from "./markdown";
import type { AgentState, ArticleImage } from "../types";

type Titled = { title: string; state: Pick<AgentState, "metadata" | "publication"> };

/** The widths images go out at, on the blog and in an export, as WebP (never enlarged). */
export const MEDIA_WIDTH = { cover: 1600, image: 1200 } as const;

/**
 * A file name's base: lowercase ASCII letters, digits and dashes (accents dropped, other scripts left out), so it is safe
 * in a link, a Content-Disposition header and any blog's build.
 */
export const fileSlug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");

export type ExportedMedia = {
  assetId: string;
  /** The file's name in the export, which the Markdown links to: cover.webp, then each image named after its alt text. */
  file: string;
  kind: "cover" | ArticleImage["kind"];
  altText: string;
  width: number;
};

/** The article's images as files: the cover, then each image placed in a section, in the article's order. */
export function exportedMedia(state: Pick<AgentState, "cover" | "images" | "sections">): ExportedMedia[] {
  const taken = new Set<string>();
  const name = (base: string) => {
    let file = `${base}.webp`;
    for (let n = 2; taken.has(file); n++) file = `${base}-${n}.webp`;
    taken.add(file);
    return file;
  };
  const cover = state.cover?.assetId
    ? [{ assetId: state.cover.assetId, file: name("cover"), kind: "cover" as const, altText: state.cover.altText, width: MEDIA_WIDTH.cover }]
    : [];
  const images = state.sections.flatMap((section) =>
    state.images
      .filter((image) => image.sectionId === section.id && image.assetId)
      .map((image) => ({
        assetId: image.assetId!,
        file: name(fileSlug(image.altText) || "image"),
        kind: image.kind,
        altText: image.altText,
        width: MEDIA_WIDTH.image,
      })),
  );
  return [...cover, ...images];
}

/** The body as the blog gets it (no title, no cover), with each image linked to its file next to the Markdown. */
export function exportMarkdown(state: Pick<AgentState, "cover" | "sections" | "images" | "videos" | "faq">) {
  const files = Object.fromEntries(exportedMedia(state).map((m) => [m.assetId, `./${m.file}`]));
  return publishMarkdown(state, files);
}

const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * YAML frontmatter: the title, the date (when it went on the blog, else `today`) and the excerpt. Strings are quoted
 * as JSON, which YAML reads as double-quoted scalars.
 */
export function exportFrontmatter(article: Titled, today = new Date()) {
  const { metadata, publication } = article.state;
  return [
    "---",
    `title: ${JSON.stringify(metadata?.h1 || article.title)}`,
    `date: ${localDate(publication ? new Date(publication.publishedAt) : today)}`,
    `excerpt: ${JSON.stringify(metadata?.excerpt ?? "")}`,
    "---",
    "",
  ].join("\n");
}

/** The name the zip of an article's images downloads as. */
export const mediaZipName = (article: Titled) =>
  `${fileSlug(article.state.metadata?.slug || article.title) || "article"}-media.zip`;
