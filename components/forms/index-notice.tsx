"use client";
import { useState } from "react";
import Link from "next/link";
import { LoaderCircleIcon } from "lucide-react";
import { startIndexingAction } from "@/app/products/actions";
import { Button } from "@/components/ui/button";
import type { IndexState } from "@/lib/products";

export type ProductIndex = { id: number; index: IndexState; indexError: string | null };

/**
 * Warns when the chosen product's site isn't indexed: the agents can then only link to pages indexed by the time they
 * write, so the article gets few or no internal links. Starting the article anyway is allowed.
 */
export function IndexNotice({ product }: { product: ProductIndex }) {
  const [started, setStarted] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const state: IndexState = started[product.id] ? "running" : product.index;
  if (state === "complete") return null;

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await startIndexingAction(product.id);
      if (result.error) setError(result.error);
      else setStarted((s) => ({ ...s, [product.id]: true }));
    } catch {
      setError("Could not start indexing. Try again from the product's page.");
    } finally {
      setBusy(false);
    }
  }

  const productLink = (
    <Link href={`/products/${product.id}`} className="underline underline-offset-4">
      product&apos;s page
    </Link>
  );
  return (
    <div role="status" className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      {state === "running" ? (
        <p className="flex items-start gap-2">
          <LoaderCircleIcon className="mt-0.5 size-3.5 shrink-0 animate-spin text-amber-600" />
          <span>
            This product&apos;s site is being indexed. An article started now can only link to the pages indexed by the
            time it is written, so wait a few minutes for the most internal links. Progress is on the {productLink}.
          </span>
        </p>
      ) : (
        <>
          <p>
            {state === "failed"
              ? `Indexing this product's site failed${product.indexError ? `: ${product.indexError}` : "."}`
              : state === "paused"
                ? "Indexing this product's site was paused part-way."
                : "This product's site isn't indexed yet."}{" "}
            Without the index, the article won&apos;t link to your own pages. You can still start it.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={start}>
              {busy && <LoaderCircleIcon className="animate-spin" />}
              {state === "paused" ? "Resume indexing" : state === "failed" ? "Index again" : "Index now"}
            </Button>
            {state === "failed" && <span className="text-xs text-muted-foreground">Check the website settings on the {productLink}.</span>}
          </div>
        </>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
