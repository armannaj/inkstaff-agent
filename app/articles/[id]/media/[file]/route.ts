import { getAgentArticle } from "@/lib/agent/store";
import { exportedMedia } from "@/lib/agent/content/export";
import { downloadResponse, exportedFile, notFound } from "@/lib/agent/publish/export-media";

/** Export as → Markdown → Media: one of the article's images, under the name the exported Markdown links it by. */
export async function GET(_request: Request, { params }: RouteContext<"/articles/[id]/media/[file]">) {
  const { id, file } = await params;
  const article = await getAgentArticle(id);
  const media = article && exportedMedia(article.state).find((m) => m.file === file);
  const data = media && (await exportedFile(media));
  if (!media || !data) return notFound();
  return downloadResponse(data, "image/webp", media.file);
}
