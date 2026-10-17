import { load } from "cheerio";
import { NodeHtmlMarkdown } from "node-html-markdown";

const converter = new NodeHtmlMarkdown({ keepDataImages: false });

/**
 * A page's raw HTML as Markdown: every heading, paragraph, list, table, link and image (with its alt text and
 * address), without the code no reader sees (scripts, styles, inline SVG icons). Links and image addresses are made
 * absolute, so agents can open or capture them. Done in memory each time; the raw HTML stays stored as fetched.
 */
export function htmlToMarkdown(html: string, pageUrl: string) {
  const $ = load(html);
  $("script, style, noscript, template, svg, iframe:not([src*='youtube'])").remove();
  const absolute = (value: string | undefined) => {
    if (!value || value.startsWith("data:")) return value;
    try {
      return new URL(value, pageUrl).href;
    } catch {
      return value;
    }
  };
  $("a[href]").each((_, el) => void $(el).attr("href", absolute($(el).attr("href"))));
  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("srcset")?.split(/\s+/)[0];
    if (src) $(el).attr("src", absolute(src));
  });
  $("iframe[src]").each((_, el) => {
    const src = absolute($(el).attr("src"));
    $(el).replaceWith($("<p>").append($("<a>").attr("href", src ?? "").text("Embedded video")));
  });
  return converter.translate($.html()).replace(/\n{3,}/g, "\n\n").trim();
}
