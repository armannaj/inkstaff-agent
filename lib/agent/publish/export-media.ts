import "server-only";
import { getAsset } from "../store";
import type { ExportedMedia } from "../content/export";
import { blogWebp } from "./publish";

/** One exported image, as the blog would get it (WebP at the publishing width); null when its asset is gone. */
export async function exportedFile(media: ExportedMedia) {
  const asset = await getAsset(media.assetId);
  return asset ? blogWebp(asset.base64, media.width) : null;
}

/** A download. Names come from exportedMedia and mediaZipName: lowercase letters, digits and dashes. */
export function downloadResponse(body: Buffer, contentType: string, fileName: string) {
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const notFound = (message = "Not found") =>
  new Response(message, { status: 404, headers: { "Cache-Control": "no-store" } });
