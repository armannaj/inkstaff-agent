import { getAgentArticle } from "@/lib/agent/store";
import { exportedMedia, mediaZipName } from "@/lib/agent/content/export";
import { downloadResponse, exportedFile, notFound } from "@/lib/agent/publish/export-media";
import { zip } from "@/lib/zip";

/** Export as → Markdown → Media: all of the article's images in one zip, named as the exported Markdown links them. */
export async function GET(_request: Request, { params }: RouteContext<"/articles/[id]/media">) {
  const { id } = await params;
  const article = await getAgentArticle(id);
  if (!article) return notFound();
  const files = [];
  for (const media of exportedMedia(article.state)) {
    const data = await exportedFile(media);
    if (data) files.push({ name: media.file, data });
  }
  if (!files.length) return notFound("This article has no images.");
  return downloadResponse(zip(files), "application/zip", mediaZipName(article));
}
