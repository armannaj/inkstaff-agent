"use client";
import { useMemo, useState } from "react";
import Image from "next/image";
import { Tabs } from "radix-ui";
import { CheckIcon, CopyIcon, DownloadIcon, FileArchiveIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { exportFrontmatter, exportMarkdown, exportedMedia, mediaZipName, type ExportedMedia } from "@/lib/agent/content/export";
import type { AgentArticle } from "@/lib/agent/types";

const KIND_LABELS: Record<ExportedMedia["kind"], string> = {
  cover: "Cover",
  screenshot: "Screenshot",
  illustration: "Illustration",
  infographic: "Infographic",
};

/**
 * Export as → Markdown: the body, its frontmatter, and its images as files (one by one, or all in a zip). The Markdown
 * links each image by its file name, so the three go together in one folder. Shows the article as last saved.
 */
export function ExportMarkdownDialog({ article, onClose }: { article: AgentArticle; onClose: () => void }) {
  const { state } = article;
  const markdown = useMemo(() => exportMarkdown(state), [state]);
  const frontmatter = useMemo(() => exportFrontmatter(article), [article]);
  const media = useMemo(() => exportedMedia(state), [state]);
  const mediaUrl = `/articles/${encodeURIComponent(article.id)}/media`;
  const tabs = [
    ["markdown", "Markdown"],
    ["frontmatter", "Frontmatter"],
    ["media", `Media (${media.length})`],
  ] as const;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* A fixed height, so switching tabs doesn't resize the dialog and move the tabs from under the pointer. */}
      <DialogContent className="h-[min(85dvh,760px)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Export as Markdown</DialogTitle>
          <DialogDescription>{article.title}</DialogDescription>
        </DialogHeader>
        <Tabs.Root defaultValue="markdown" className="flex min-h-0 min-w-0 flex-col gap-4">
          <Tabs.List className="flex flex-wrap gap-1 border-b" aria-label="Export">
            {tabs.map(([value, label]) => (
              <Tabs.Trigger
                key={value}
                value={value}
                className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground"
              >
                {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="markdown" className="flex min-h-0 flex-1 flex-col gap-2 outline-none">
            <TextPanel
              text={markdown}
              about="The body as the blog gets it, without the title (it's in the frontmatter). Each image links to its file under Media, in the same folder."
            />
          </Tabs.Content>

          <Tabs.Content value="frontmatter" className="flex min-h-0 flex-1 flex-col gap-2 outline-none">
            <TextPanel
              text={frontmatter}
              about={`YAML, to put above the Markdown. The date is ${state.publication ? "the day it went on the blog" : "today's, as it isn't on the blog yet"}.`}
            />
          </Tabs.Content>

          <Tabs.Content value="media" className="flex min-h-0 flex-1 flex-col gap-3 outline-none">
            {media.length ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">WebP, sized as the blog gets them, named as the Markdown links them.</p>
                  <ZipButton url={mediaUrl} fileName={mediaZipName(article)} />
                </div>
                <ul className="min-h-0 divide-y overflow-auto rounded-lg border">
                  {media.map((m) => (
                    <li key={m.file} className="flex items-center gap-3 p-2">
                      <Image
                        unoptimized
                        src={`/assets/${encodeURIComponent(m.assetId)}`}
                        alt=""
                        width={80}
                        height={45}
                        className="aspect-video w-20 shrink-0 rounded border object-cover"
                      />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="truncate font-medium">{m.file}</p>
                        <p className="truncate text-xs text-muted-foreground" title={m.altText}>
                          {KIND_LABELS[m.kind]} · {m.altText}
                        </p>
                      </div>
                      <Button asChild size="sm" variant="outline">
                        <a href={`${mediaUrl}/${m.file}`} download={m.file}>
                          <DownloadIcon /> Download
                        </a>
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">This article has no images.</p>
            )}
          </Tabs.Content>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  );
}

function TextPanel({ text, about }: { text: string; about: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied(null), 2000);
  }
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{about}</p>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied === "yes" ? <CheckIcon /> : <CopyIcon />}
          {copied === "yes" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs wrap-break-word whitespace-pre-wrap">{text}</pre>
    </>
  );
}

/** Fetched first rather than linked: the images are converted on the way out, so the zip takes a moment to start. */
function ZipButton({ url, fileName }: { url: string; fileName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function download() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error();
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = href;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      setError("The zip couldn't be made. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button size="sm" disabled={busy} onClick={download}>
        {busy ? <LoaderCircleIcon className="animate-spin" /> : <FileArchiveIcon />} Download all (.zip)
      </Button>
    </div>
  );
}
