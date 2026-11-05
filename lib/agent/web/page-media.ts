import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { youtubeVideoId } from "./youtube";

/**
 * Demos and videos a page offers: embedded or linked videos (YouTube, Vimeo, Loom, Wistia, a playable file),
 * interactive product tours, and links to a demo or example, on another page of the site or in a section of this one.
 * The site index looks for them on the product's home page, so articles can show the product with its own material.
 */
export type PageMedia = {
  kind: "video" | "demo";
  /** The video's or demo's own address; for a section of the page, the page with #id. */
  url: string;
  /** What the page calls it: the link's text, the frame's title, or the section's heading. */
  label: string;
  host: "youtube" | "vimeo" | "loom" | "wistia" | "file" | "interactive" | "page" | "section";
  /** The text around it, so agents can tell what it shows (and whether its example is real or invented). */
  context: string;
  /** A section of the page: the CSS selector that captures it in a screenshot. */
  selector?: string;
};

/** Hosts of interactive product tours (click-through demos). */
const INTERACTIVE = /(^|\.)(arcade\.software|storylane\.io|navattic\.com|supademo\.com|walnut\.io|howdygo\.com|tourial\.com|guidejar\.com|reprise\.com)$/i;
const DEMO_TEXT = /\b(demo|example|sample|walkthrough|product tour|tour|watch|video|see it in action)\b/i;
const DEMO_PATH = /(^|[/#])(demo|tour|example|sample|walkthrough|video)s?([/?#._-]|$)/i;
/** "Book a demo" leads to a sales call, not to something an article can show. */
const BOOKING = /\b(book|schedule|request|get|talk|contact|call)\b.{0,12}\b(demo|call|meeting)\b/i;
const MAX_ITEMS = 8;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** A video or interactive demo from an address: its canonical URL and host, or null. */
function hosted(url: URL): Pick<PageMedia, "kind" | "url" | "host"> | null {
  const youtube = youtubeVideoId(url.href);
  if (youtube) return { kind: "video", url: `https://www.youtube.com/watch?v=${youtube}`, host: "youtube" };
  const host = url.hostname.replace(/^www\./, "");
  const vimeo = host === "player.vimeo.com" ? /^\/video\/(\d+)/.exec(url.pathname) : host === "vimeo.com" ? /^\/(\d+)/.exec(url.pathname) : null;
  if (vimeo) return { kind: "video", url: `https://vimeo.com/${vimeo[1]}`, host: "vimeo" };
  const loom = host === "loom.com" ? /^\/(?:share|embed)\/([\w-]+)/.exec(url.pathname) : null;
  if (loom) return { kind: "video", url: `https://www.loom.com/share/${loom[1]}`, host: "loom" };
  if (/(^|\.)wistia\.(com|net)$/.test(host) && /\/(medias|embed)\//.test(url.pathname))
    return { kind: "video", url: url.href, host: "wistia" };
  if (INTERACTIVE.test(host)) return { kind: "demo", url: url.href, host: "interactive" };
  return null;
}

function absolute(value: string | undefined, base: string) {
  if (!value || /^(mailto|tel|javascript|data):/i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The heading and opening text of the section around an element. */
function contextOf($: CheerioAPI, element: AnyNode, own = false) {
  const node = $(element);
  const scope = own ? node : node.closest("section, article, [id]").first();
  const area = scope.length ? scope : node.parent();
  const heading = collapse(area.find("h1, h2, h3").first().text());
  const text = collapse(area.text());
  return { heading, context: (heading && !text.startsWith(heading) ? `${heading}: ${text}` : text).slice(0, 500) };
}

const label = ($: CheerioAPI, element: AnyNode) => {
  const node = $(element);
  return collapse(node.text() || node.attr("aria-label") || node.attr("title") || "").slice(0, 120);
};

export function findPageMedia(html: string, pageUrl: string): PageMedia[] {
  const $ = load(html);
  $("script, style, noscript, template").remove();
  // Words in neighbouring blocks stay apart in the text.
  $("p, div, li, h1, h2, h3, h4, h5, h6, pre, tr, td, th, dt, dd, br, a, button").append(" ");
  const page = new URL(pageUrl);
  const found = new Map<string, PageMedia>();
  const add = (item: PageMedia) => {
    const existing = found.get(item.url);
    // The same thing linked twice (menu and body): keep its most descriptive name.
    if (existing) {
      if (item.label.length > existing.label.length) existing.label = item.label;
      return;
    }
    found.set(item.url, item);
  };

  $("iframe").each((_, element) => {
    const url = absolute($(element).attr("src") ?? $(element).attr("data-src"), pageUrl);
    const media = url && hosted(url);
    if (!media) return;
    const { heading, context } = contextOf($, element);
    add({ ...media, label: collapse($(element).attr("title") ?? "") || heading, context });
  });

  // Self-hosted videos with controls; silent autoplaying loops are page decoration.
  $("video[controls]").each((_, element) => {
    const url = absolute($(element).attr("src") ?? $(element).find("source[src]").first().attr("src"), pageUrl);
    if (!url) return;
    const { heading, context } = contextOf($, element);
    add({ kind: "video", url: url.href, host: "file", label: collapse($(element).attr("title") ?? "") || heading, context });
  });

  $("a[href]").each((_, element) => {
    const url = absolute($(element).attr("href"), pageUrl);
    if (!url) return;
    const text = label($, element);
    const media = hosted(url);
    if (media) {
      add({ ...media, label: text, context: contextOf($, element).context });
      return;
    }
    if (BOOKING.test(text) || !(DEMO_TEXT.test(text) || DEMO_PATH.test(url.pathname + url.hash))) return;
    if (url.hostname.replace(/^www\./, "") !== page.hostname.replace(/^www\./, "")) return;
    const samePage = url.pathname.replace(/\/$/, "") === page.pathname.replace(/\/$/, "") && url.search === page.search;
    if (samePage) {
      if (!url.hash) return;
      let id: string;
      try {
        id = decodeURIComponent(url.hash.slice(1));
      } catch {
        return;
      }
      const selector = /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/["\\]/g, "\\$&")}"]`;
      const section = $(selector).first();
      if (!section.length) return;
      const { context } = contextOf($, section[0], true);
      add({ kind: "demo", url: `${page.origin}${page.pathname}${page.search}#${id}`, host: "section", label: text, context, selector });
      return;
    }
    add({ kind: "demo", url: url.href.replace(/#$/, ""), host: "page", label: text, context: contextOf($, element).context });
  });

  return [...found.values()].slice(0, MAX_ITEMS);
}
