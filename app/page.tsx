import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";
import { BotIcon, ImageIcon, PlusIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { DeleteAgentArticle } from "@/components/agent/delete-article";
import { STATUS_LABELS, formatUsd } from "@/components/agent/labels";
import { listAgentArticles } from "@/lib/agent/store";
import { agentLabel } from "@/lib/agent/types";

export default function ArticlesPage() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Articles</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            A Director agent runs Research, Editor, Writer, Graphics and Reviewer agents in the background until the
            article passes review. Then edit, regenerate images and publish.
          </p>
        </div>
        <Link href="/articles/new" className={buttonVariants()}>
          <PlusIcon /> New article
        </Link>
      </header>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading articles…</p>}>
        <ArticleList />
      </Suspense>
    </main>
  );
}

async function ArticleList() {
  await connection();
  const articles = await listAgentArticles();
  if (!articles.length)
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-16 text-center">
        <BotIcon className="mb-4 size-9 text-muted-foreground" />
        <h2 className="text-lg font-medium">Give the agents a keyword</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          They research it, plan the article, write it, add images and review it until it&apos;s good enough to show you.
        </p>
        <Link href="/articles/new" className={`${buttonVariants()} mt-6`}>
          Start the first article
        </Link>
      </div>
    );
  const listed = new Set(articles.map((a) => a.id));
  // Articles published before the replaced post was recorded on them are found from the article they replaced.
  const replacers = new Map(articles.flatMap((a) => (a.replacedById ? [[a.replacedById, a] as const] : [])));
  const replacedPost = (article: ListedArticle): ReplacedPost | null => {
    if (article.replacedTitle != null) return { title: article.replacedTitle, articleId: article.replacedArticleId };
    const old = replacers.get(article.id);
    return old ? { title: old.title, articleId: old.id } : null;
  };
  return (
    <ul className="divide-y overflow-hidden rounded-xl border" aria-label="Articles">
      {articles.map((article) => (
        <li key={article.id} className="flex flex-col gap-3 p-5 hover:bg-muted/40 sm:flex-row sm:items-center">
          <Link href={`/articles/${article.id}`} className="flex min-w-0 flex-1 flex-col gap-4 sm:flex-row sm:items-center">
            <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-lg border bg-muted/30 sm:w-48">
              {article.coverAssetId ? (
                <Image unoptimized fill src={`/assets/${encodeURIComponent(article.coverAssetId)}`} alt="" className="object-contain" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                  <ImageIcon className="size-5" aria-hidden="true" />
                  No cover yet
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="break-words font-medium">{article.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {article.productName} · {article.wordCount.toLocaleString()} words
                {article.costUsd != null ? ` · ${formatUsd(article.costUsd)}` : ""} ·{" "}
                {article.updatedAt.toLocaleDateString()}
                {article.status === "running" && article.currentAgent ? ` · ${agentLabel(article.currentAgent)} working` : ""}
              </p>
            </div>
          </Link>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {article.publishedAt && <PublishedBadge article={article} replaced={replacedPost(article)} listed={listed} />}
            {article.status !== "ready" && (
              <span className="rounded-full bg-secondary px-3 py-1 text-xs">{STATUS_LABELS[article.status]}</span>
            )}
            <DeleteAgentArticle id={article.id} title={article.title} published={!!article.publishedAt} />
          </div>
        </li>
      ))}
    </ul>
  );
}

type ListedArticle = Awaited<ReturnType<typeof listAgentArticles>>[number];
type ReplacedPost = { title: string; articleId: string | null };

/** "Published", or "Published As" with the post it took the place of underneath when it replaced one. */
function PublishedBadge({ article, replaced, listed }: { article: ListedArticle; replaced: ReplacedPost | null; listed: Set<string> }) {
  const badge = (
    <a
      href={article.publishedUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-full bg-emerald-100 px-3 py-1 text-xs text-emerald-800 hover:underline dark:bg-emerald-950 dark:text-emerald-300"
    >
      {replaced ? "Published As" : "Published"}
    </a>
  );
  if (!replaced) return badge;
  const hint = `Replaced "${replaced.title}" on the blog`;
  const text = "max-w-48 truncate text-[11px] leading-tight text-muted-foreground";
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      {badge}
      {replaced.articleId && listed.has(replaced.articleId) ? (
        <Link href={`/articles/${replaced.articleId}`} title={hint} className={`${text} hover:underline`}>
          {replaced.title}
        </Link>
      ) : (
        <span title={hint} className={text}>
          {replaced.title}
        </span>
      )}
    </div>
  );
}
