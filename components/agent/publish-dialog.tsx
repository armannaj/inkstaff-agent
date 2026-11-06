"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LoaderCircleIcon, SearchIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { publishTargetsAction } from "@/app/articles/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AgentArticle, PublishTarget } from "@/lib/agent/types";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const SOURCE_LABELS: Record<PublishTarget["source"], string> = {
  inkstaff: "Published from Inkstaff",
  rewrite: "The post this article rewrites",
  index: "From the site index",
};

/**
 * Publish as a new post, or in place of a post already on the blog (keeping its address). An article already on the
 * blog only updates its own post; one written to rewrite a post replaces that post.
 */
export function PublishDialog({
  article,
  host,
  busy,
  error,
  onClose,
  onPublish,
}: {
  article: AgentArticle;
  host: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  /** null: the article's own post (a new one, or an update of it). */
  onPublish: (target: PublishTarget | null) => void;
}) {
  const { state } = article;
  const mode = state.publication ? "update" : state.existingPost ? "rewrite" : "choose";
  const [targets, setTargets] = useState<PublishTarget[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [choice, setChoice] = useState<"new" | "replace">("new");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (mode === "update") return;
    let cancelled = false;
    publishTargetsAction(article.id)
      .then((result) => {
        if (cancelled) return;
        if (result.error) setLoadError(result.error);
        else setTargets(result.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setLoadError("The blog's posts could not be loaded. Close this and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [mode, article.id]);

  // The chosen post stays listed while searching, so what the summary describes is always in view.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (targets ?? []).filter((t) => !q || t.slug === selected || t.title.toLowerCase().includes(q) || t.slug.includes(q));
  }, [targets, query, selected]);

  const loading = mode !== "update" && !targets && !loadError;
  const slug = state.metadata?.slug ?? "";
  const taken = mode === "choose" ? targets?.find((t) => t.slug === slug) : undefined;
  const target =
    mode === "rewrite"
      ? targets?.find((t) => t.slug === state.existingPost!.slug)
      : mode === "choose" && choice === "replace"
        ? targets?.find((t) => t.slug === selected)
        : undefined;
  const replacing = mode === "rewrite" || choice === "replace";
  const ready = mode === "update" || (replacing ? !!target : !loading && !taken);
  const uploads = { count: (state.cover?.assetId ? 1 : 0) + state.images.filter((i) => i.assetId).length, cover: !!state.cover?.assetId };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        closeDisabled={busy}
        className="sm:max-w-xl"
        onInteractOutside={(e) => busy && e.preventDefault()}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "update" ? "Update the post" : mode === "rewrite" ? "Replace the post" : "Publish"} on {host}
          </DialogTitle>
          <DialogDescription>{article.title}</DialogDescription>
        </DialogHeader>

        {mode === "update" && (
          <p className="text-sm">
            Sends the article as it is now to{" "}
            <a href={state.publication!.url ?? undefined} target="_blank" rel="noopener noreferrer" className="break-all underline">
              /blog/{state.publication!.slug}
            </a>
            . Images it no longer uses are deleted from the image storage once the blog accepts the update.
          </p>
        )}

        {mode === "rewrite" && (
          <div className="space-y-3">
            <p className="text-sm">
              This article was written to rewrite{" "}
              <a href={state.existingPost!.url} target="_blank" rel="noopener noreferrer" className="underline">
                {state.existingPost!.title}
              </a>
              , so it replaces that post at its address.
            </p>
            {target ? <ReplaceSteps target={target} uploads={uploads} /> : loading && <Loading />}
          </div>
        )}

        {mode === "choose" && (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="sr-only">How to publish</legend>
            <Option
              name="publish-mode"
              checked={choice === "new"}
              onSelect={() => setChoice("new")}
              title="Publish as a new post"
              description={`A new post at /blog/${slug}.`}
            >
              {taken && (
                <Warning>
                  &ldquo;{taken.title}&rdquo; is already at this address. Publishing a new post there would overwrite it and leave
                  its images behind.{" "}
                  <button
                    type="button"
                    className="font-medium underline underline-offset-4"
                    onClick={() => {
                      setChoice("replace");
                      setSelected(taken.slug);
                    }}
                  >
                    Replace it instead
                  </button>
                  , or change the slug in the SEO tab.
                </Warning>
              )}
            </Option>
            <Option
              name="publish-mode"
              checked={choice === "replace"}
              onSelect={() => setChoice("replace")}
              title="Replace a post on the blog"
              description="This article takes over the post's address. The old post's images are deleted from the image storage first."
            />
            {choice === "replace" && (
              <div className="space-y-3 pt-1">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search posts by title or address"
                    aria-label="Search the blog's posts"
                    className="pl-8"
                  />
                </div>
                {loading ? (
                  <Loading />
                ) : !targets?.length ? (
                  !loadError && (
                    <p className="text-sm text-muted-foreground">
                      No posts found. Posts show here once they are published from Inkstaff, or indexed from the site&apos;s
                      sitemap at /blog/&lt;slug&gt;.
                    </p>
                  )
                ) : !shown.length ? (
                  <p className="text-sm text-muted-foreground">No post matches &ldquo;{query}&rdquo;.</p>
                ) : (
                  <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border" aria-label="Posts on the blog">
                    {shown.map((t) => (
                      <li key={t.slug}>
                        <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/50 has-checked:bg-muted">
                          <input
                            type="radio"
                            name="replace-target"
                            value={t.slug}
                            checked={selected === t.slug}
                            onChange={() => setSelected(t.slug)}
                            className="mt-1 accent-primary"
                          />
                          <span className="min-w-0 text-sm">
                            <span className="block font-medium break-words">{t.title}</span>
                            <span className="block text-xs break-all text-muted-foreground">
                              /blog/{t.slug} · {SOURCE_LABELS[t.source]}
                              {t.source === "inkstaff" ? ` · ${plural(t.images, "image")}` : ""}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {target && <ReplaceSteps target={target} uploads={uploads} />}
              </div>
            )}
          </fieldset>
        )}

        {(error || loadError) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? loadError}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !ready} onClick={() => onPublish(replacing && target ? target : null)}>
            {busy ? <LoaderCircleIcon className="animate-spin" /> : <UploadIcon />}
            {mode === "update" ? "Update post" : replacing ? "Replace post" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Option({
  name,
  checked,
  onSelect,
  title,
  description,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-3 ${checked ? "border-foreground/40 bg-muted/40" : ""}`}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-1 accent-primary" />
        <span className="min-w-0 text-sm">
          <span className="block font-medium">{title}</span>
          <span className="block break-words text-muted-foreground">{description}</span>
        </span>
      </label>
      {children && <div className="mt-2 pl-7">{children}</div>}
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-sm text-amber-700 dark:text-amber-400">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" aria-hidden /> Loading the blog&apos;s posts…
    </p>
  );
}

/** What replacing the post does, in the order it happens. */
function ReplaceSteps({ target, uploads }: { target: PublishTarget; uploads: { count: number; cover: boolean } }) {
  const owners = target.articleIds.length;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
      <p className="font-medium">What happens</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          {target.images
            ? `Delete its ${plural(target.images, "image")} from the image storage.`
            : owners
              ? "No old images to delete: it has none in the image storage."
              : "No old images to delete: its images weren't uploaded from Inkstaff, so they stay as they are."}
        </li>
        <li>
          {uploads.count
            ? `Upload this article's ${plural(uploads.count, "image")}${uploads.cover ? " (cover included)" : ""}.`
            : "No new images to upload."}
        </li>
        <li>
          Replace the post at{" "}
          <a href={target.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
            /blog/{target.slug}
          </a>{" "}
          with this article&apos;s title, content and cover. Its address stays the same.
        </li>
        {owners > 0 && (
          <li>
            {owners === 1
              ? `Mark "${target.title}" as replaced here, so it no longer shows as published.`
              : `Mark the ${owners} articles that published it as replaced here, so they no longer show as published.`}
          </li>
        )}
      </ol>
      {target.images > 0 && (
        <p className="text-xs text-muted-foreground">
          The old images are deleted first. If the blog then rejects the update, the old post shows without its images
          until you publish again.
        </p>
      )}
    </div>
  );
}
