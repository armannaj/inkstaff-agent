import ipaddr from "ipaddr.js";

export function isPublicAddress(address: string) {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function publicUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port)) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (ipaddr.isValid(hostname) && !isPublicAddress(hostname))
  ) {
    throw new Error(
      "Only public HTTP(S) addresses on standard ports are allowed.",
    );
  }
  url.hash = "";
  return url;
}
export function sameSite(value: string, website: string) {
  try {
    return publicUrl(value).origin === publicUrl(website).origin;
  } catch {
    return false;
  }
}
export function normalizedUrl(value: string) {
  const url = publicUrl(value);
  return `${url.origin}${url.pathname.replace(/\/$/, "")}${url.search}`;
}
/** The same page, whatever the protocol, www prefix or trailing slash. */
export function samePage(a: string, b: string) {
  const key = (value: string) =>
    normalizedUrl(value).replace(/^https?:\/\/(www\.)?/, "");
  try {
    return key(a) === key(b);
  } catch {
    return false;
  }
}
export function isExcluded(value: string, excluded: string[]) {
  const candidate = normalizedUrl(value);
  return excluded.some((item) => {
    const base = normalizedUrl(item);
    return (
      candidate === base ||
      candidate.startsWith(`${base}/`) ||
      candidate.startsWith(`${base}?`)
    );
  });
}
