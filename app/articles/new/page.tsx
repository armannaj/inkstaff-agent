import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { NewArticleForm, type ArticlePrefill } from "@/components/forms/new-article";
import { hasDataForSeo } from "@/lib/dataforseo";
import { listProducts } from "@/lib/products";

export const metadata: Metadata = { title: "New article" };

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 2000) || undefined;
const positiveId = (value: string | string[] | undefined) => {
  const id = Number(first(value));
  return Number.isInteger(id) && id > 0 ? id : undefined;
};

/** Accepts a prefill: ?product=ID&keyword=…&keywords=a,b&audience=… */
export default function NewArticlePage({ searchParams }: PageProps<"/articles/new">) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-8 sm:px-8">
      <header>
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          ← All articles
        </Link>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">New article</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A Director agent runs Research, Editor, Writer, Graphics and Reviewer agents until the article passes review.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Form searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Form({ searchParams }: Pick<PageProps<"/articles/new">, "searchParams">) {
  await connection();
  const query = await searchParams;
  const products = (await listProducts()).map(({ id, name, index, indexError }) => ({ id, name, index, indexError }));
  const prefill: ArticlePrefill = {
    productId: positiveId(query.product),
    primaryKeyword: first(query.keyword)?.slice(0, 200),
    additionalKeywords: first(query.keywords)
      ?.split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 30),
    targetAudience: first(query.audience),
  };
  return (
    <NewArticleForm
      products={products}
      prefill={prefill}
      configured={Boolean(process.env.OPENROUTER_API_KEY && hasDataForSeo())}
    />
  );
}
