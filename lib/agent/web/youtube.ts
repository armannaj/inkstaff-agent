/** A YouTube video's ID from its URL (watch?v=, youtu.be/, /shorts/, /embed/, /live/), or null. */
export function youtubeVideoId(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^(www|m|music)\./, "");
  const id =
    host === "youtu.be"
      ? parsed.pathname.split("/")[1]
      : host === "youtube.com" || host === "youtube-nocookie.com"
        ? (parsed.searchParams.get("v") ?? /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(parsed.pathname)?.[1])
        : undefined;
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}
