import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { AgentEditor } from "@/components/agent/agent-editor";
import { getAgentArticleView, publishingSettings } from "@/lib/agent/store";
import { kickRunner } from "@/lib/agent/runner";
import { AGENT_NAMES } from "@/lib/agent/agents";
import { AGENT_BUDGET_USD } from "@/lib/config";

export const metadata: Metadata = { title: "Article" };

export default function ArticlePage({ params }: PageProps<"/articles/[id]">) {
  return (
    <Suspense fallback={<p className="mx-auto max-w-5xl px-5 py-8 text-sm text-muted-foreground sm:px-8">Loading the article…</p>}>
      <Editor params={params} />
    </Suspense>
  );
}

async function Editor({ params }: Pick<PageProps<"/articles/[id]">, "params">) {
  await connection();
  const { id } = await params;
  const article = await getAgentArticleView(id);
  if (!article) notFound();
  // A queued article left waiting by a restart gets picked up when someone looks at it.
  if (article.status === "queued" || article.status === "running") kickRunner();
  const product = await publishingSettings(article.productId);
  return (
    <AgentEditor
      initialArticle={article}
      publishTo={product?.publishing ? product.host : null}
      team={AGENT_NAMES}
      budgetUsd={AGENT_BUDGET_USD}
    />
  );
}
