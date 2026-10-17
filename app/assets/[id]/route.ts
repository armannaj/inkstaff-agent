import { createHash } from "node:crypto";
import { getAsset } from "@/lib/agent/store";

/** Serves the agents' images (screenshots, illustrations, covers). */
export async function GET(request: Request, { params }: RouteContext<"/assets/[id]">) {
  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset || !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType))
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const body = Buffer.from(asset.base64, "base64");
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  const unchanged = request.headers
    .get("if-none-match")
    ?.split(",")
    .some((tag) => tag.trim().replace(/^W\//, "") === etag);
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(unchanged ? null : body, {
    status: unchanged ? 304 : 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Cache-Control": "private, no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      ...(download ? { "Content-Disposition": `attachment; filename="${id}.${asset.mimeType.split("/")[1]}"` } : {}),
    },
  });
}
