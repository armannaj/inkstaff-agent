import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import { visit, SKIP } from "unist-util-visit";
import { isExcluded, sameSite } from "../web/url-safety";
import type { AgentState, ArticleInput, Section } from "../types";

/**
 * Pages an article may link: pages an agent actually read, and the product's site pages agents found (never a URL
 * nobody opened). Which of them to cite is the agents' editorial call; the author's excluded pages stay out.
 */
export function allowedUrls(state: Pick<AgentState, "sitePages" | "sources" | "website">) {
  return new Set(
    [...state.sitePages.map((page) => page.url), ...state.sources.map((s) => s.url)].filter(
      (url) => !isExcluded(url, state.website.excludedPages),
    ),
  );
}
export function internalUrls(state: Pick<AgentState, "sitePages" | "sources" | "website">) {
  return new Set([
    ...state.sitePages.map((page) => page.url),
    ...state.sources.filter((s) => sameSite(s.url, state.website.websiteUrl)).map((s) => s.url),
  ]);
}
/**
 * A heading's id as common Markdown renderers give it (text in parentheses dropped, punctuation removed,
 * spaces to hyphens, lowercase), so `[text](#id)` jumps to it. Repeats get -2, -3… (see headingAnchors).
 */
export function headingId(text: string) {
  return (
    text
      .trim()
      .replace(/\([^)]*\)/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .toLowerCase() || "section"
  );
}

const plainText = (node: unknown): string => {
  const n = node as { value?: string; children?: unknown[] };
  return typeof n.value === "string" ? n.value : (n.children ?? []).map(plainText).join("");
};

/**
 * Every heading on the published page with its id, in page order: each section's heading (an H2), then the headings
 * inside it. Planned sections not written yet count with their planned heading, so an early section can link ahead.
 */
export function headingAnchors(
  sections: Pick<Section, "id" | "heading" | "markdown">[],
  planned: { id: string; heading: string }[] = [],
) {
  const order = [
    ...planned.map((p) => sections.find((s) => s.id === p.id) ?? { ...p, markdown: "" }),
    ...sections.filter((s) => !planned.some((p) => p.id === s.id)),
  ];
  const parser = unified().use(remarkParse).use(remarkGfm);
  const anchors: { heading: string; id: string }[] = [];
  const add = (heading: string) => {
    const base = headingId(heading);
    let id = base;
    for (let n = 2; anchors.some((a) => a.id === id); n++) id = `${base}-${n}`;
    anchors.push({ heading, id });
  };
  for (const section of order) {
    add(section.heading);
    visit(parser.parse(section.markdown), "heading", (node) => {
      add(plainText(node));
    });
  }
  return anchors;
}

const fragment = (url: string) => {
  try {
    return decodeURIComponent(url.slice(1));
  } catch {
    return url.slice(1);
  }
};
/** "auto": the agents decide how many links help; only a number from the author caps them. */
const limit = (value: number | "auto") => (value === "auto" ? Infinity : value);

/**
 * Removes links an article may not have: to pages nobody read, excluded pages, and links over the article's limits
 * (counted by distinct page: linking a page again doesn't count twice). Links to a heading of the article itself
 * (`#id`, see headingAnchors) stay and don't count. Images and raw HTML are removed too.
 * Untouched sections keep their exact Markdown. Returns the removed URLs, so the agent learns what was dropped.
 */
export function cleanLinks(
  sections: Section[],
  state: Pick<AgentState, "sitePages" | "sources" | "website"> & { plan?: AgentState["plan"] },
  input: Pick<ArticleInput, "internalLinks" | "externalLinks">,
) {
  const allowed = allowedUrls(state);
  const anchors = new Set(headingAnchors(sections, state.plan?.sections).map((a) => a.id));
  const internal = internalUrls(state);
  const limits = { internal: limit(input.internalLinks), external: limit(input.externalLinks) };
  const seen = new Set<string>();
  const used = { internal: 0, external: 0 };
  const removed: string[] = [];
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);
  const cleaned = sections.map((section) => {
    const tree = processor.parse(section.markdown);
    let changed = false;
    const definitions = new Map<string, string>();
    visit(tree, "definition", (node) => {
      definitions.set(node.identifier.toLowerCase(), node.url);
    });
    visit(tree, (node, index, parent) => {
      if (index == null || !parent) return;
      if (node.type === "image" || node.type === "imageReference") {
        parent.children.splice(index, 1, { type: "text", value: node.alt ?? "" });
        changed = true;
        return [SKIP, index];
      }
      if (node.type === "definition" || node.type === "html") {
        parent.children.splice(index, 1);
        changed = true;
        return [SKIP, index];
      }
      if (node.type !== "link" && node.type !== "linkReference") return;
      const url = node.type === "link" ? node.url : (definitions.get(node.identifier.toLowerCase()) ?? "");
      if (url.startsWith("#") && anchors.has(fragment(url))) {
        if (node.type === "linkReference") {
          parent.children[index] = { type: "link", url, children: node.children };
          changed = true;
        }
        return SKIP;
      }
      const type = internal.has(url) ? "internal" : "external";
      const repeat = seen.has(url);
      if (!allowed.has(url) || (!repeat && used[type] >= limits[type])) {
        parent.children.splice(index, 1, ...node.children);
        removed.push(url);
        changed = true;
        return [SKIP, index];
      }
      if (!repeat) used[type]++;
      seen.add(url);
      if (node.type === "linkReference") {
        parent.children[index] = { type: "link", url, children: node.children };
        changed = true;
      }
      return SKIP;
    });
    return changed ? { ...section, markdown: processor.stringify(tree).trim() } : section;
  });
  return { sections: cleaned, removed };
}
