import "server-only";
import { lookup } from "node:dns/promises";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { load } from "cheerio";
import { isPublicAddress, publicUrl } from "./url-safety";

/** Resolve once and pin the connection to that public IP. Redirects are checked again. */
export async function fetchPublicText(
  value: string,
  redirects = 0,
): Promise<{ url: string; text: string }> {
  if (redirects > 4) throw new Error("Too many page redirects.");
  const url = publicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("The page resolves to a private or reserved address.");
  const address = addresses.find((item) => item.family === 4) ?? addresses[0];
  const response = await new Promise<{
    status: number;
    location?: string;
    text: string;
  }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "InkstaffAgent/1.0",
          Accept:
            "text/html,application/xml,text/xml,application/json,text/plain",
        },
        signal: AbortSignal.timeout(15_000),
        family: address.family,
        lookup: (_host, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (res) => {
        const contentType = res.headers["content-type"]
          ?.split(";")[0]
          .trim()
          .toLowerCase();
        if (
          res.statusCode === 200 &&
          contentType &&
          !/^(text\/|application\/(?:xml|xhtml\+xml|json|gzip|x-gzip)$)/.test(
            contentType,
          ) &&
          !(
            contentType === "application/octet-stream" &&
            url.pathname.endsWith(".gz")
          )
        ) {
          request.destroy(
            new Error("This source is not readable HTML, XML, JSON or text."),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2_000_000) {
            request.destroy(new Error("Page exceeds the 2 MB crawl limit."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            let body = Buffer.concat(chunks);
            const encoding = res.headers["content-encoding"];
            const limit = { maxOutputLength: 2_000_000 };
            if (encoding === "gzip" || (body[0] === 0x1f && body[1] === 0x8b))
              body = gunzipSync(body, limit);
            else if (encoding === "br")
              body = brotliDecompressSync(body, limit);
            else if (encoding === "deflate") body = inflateSync(body, limit);
            resolve({
              status: res.statusCode ?? 500,
              location: res.headers.location,
              text: body.toString("utf8"),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
  if (response.status >= 300 && response.status < 400 && response.location)
    return fetchPublicText(new URL(response.location, url).href, redirects + 1);
  if (response.status !== 200)
    throw new Error(`Page returned HTTP ${response.status}.`);
  return { url: url.href, text: response.text };
}
export function extractPage(html: string, url: string) {
  const $ = load(html);
  const title = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content") ?? "";
  const canonical = $('link[rel="canonical"]').attr("href");
  let canonicalUrl = url;
  try {
    if (canonical) canonicalUrl = publicUrl(new URL(canonical, url).href).href;
  } catch {
    /* Keep fetched URL. */
  }
  const publicationDate =
    $('meta[property="article:published_time"]').attr("content") ??
    $("time[datetime]").first().attr("datetime") ??
    null;
  const lastModified =
    $('meta[property="article:modified_time"]').attr("content") ?? null;
  $("script,style,nav,footer,header,aside,noscript,form").remove();
  const main = $("main,article").first();
  const root = main.length ? main : $("body");
  root.find("p,div,li,h1,h2,h3,h4,pre,tr,br").append(" ");
  // The whole readable text: the 2 MB download limit bounds it.
  const content = root.text().replace(/\s+/g, " ").trim();
  return {
    url,
    title,
    metaDescription,
    h1: $("h1").first().text().trim(),
    headings: root
      .find("h2,h3")
      .map((_, el) => $(el).text().trim())
      .get()
      .slice(0, 60),
    content,
    canonicalUrl,
    publicationDate,
    lastModified,
  };
}
/**
 * A page as fetched: its raw HTML (what agents get), plus the extracted text, which code uses for its checks (numbers,
 * quotes, links). Never refuses a page for having little text: a page drawn by JavaScript is still returned raw.
 */
export async function fetchPage(url: string) {
  const response = await fetchPublicText(url);
  return { url: response.url, html: response.text, page: extractPage(response.text, response.url) };
}
export async function readPage(url: string) {
  const response = await fetchPublicText(url);
  const page = extractPage(response.text, response.url);
  if (page.content.length < 120)
    throw new Error("Page has too little readable content to use as evidence.");
  return page;
}

/** The post being rewritten: on the product's site, with an address ending in a slug the site stores it under. */
export async function readExistingPost(url: string, websiteUrl: string) {
  const page = await readPage(url).catch((error) => {
    throw new Error(
      `Could not read the post to rewrite: ${error instanceof Error ? error.message : "the page is unavailable."}`,
    );
  });
  const host = (value: string) => new URL(value).hostname.replace(/^www\./, "");
  if (host(page.url) !== host(websiteUrl)) throw new Error("The post to rewrite must be on this product's website.");
  const slug = new URL(page.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error("The post to rewrite needs an address ending in a slug, such as /blog/my-post.");
  return { url: page.url, slug, title: page.h1 || page.title, headings: page.headings, content: page.content };
}
