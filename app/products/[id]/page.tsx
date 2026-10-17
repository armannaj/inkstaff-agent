import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { FormGroup } from "@/components/forms/fields";
import { DeleteProduct } from "@/components/products/delete-product";
import { PublishingSettings } from "@/components/products/publishing-settings";
import { ProductSettingsForm } from "@/components/products/writing-settings";
import { getProduct } from "@/lib/products";

export const metadata: Metadata = { title: "Product" };

export default function ProductPage({ params }: PageProps<"/products/[id]">) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-5 py-8 sm:px-8">
      <Link href="/products" className="text-sm text-muted-foreground hover:underline">
        ← All products
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading the product…</p>}>
        <Product params={params} />
      </Suspense>
    </main>
  );
}

async function Product({ params }: Pick<PageProps<"/products/[id]">, "params">) {
  await connection();
  const id = Number((await params).id);
  const product = Number.isInteger(id) && id > 0 ? await getProduct(id) : null;
  if (!product) notFound();
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{product.settings.websiteUrl}</p>
        </div>
        <Link href={`/articles/new?product=${product.id}`} className="text-sm underline underline-offset-4">
          New article for this product
        </Link>
      </header>
      <ProductSettingsForm initialProduct={product} />
      <FormGroup title="Publishing">
        <PublishingSettings productId={product.id} initial={product.publishing} />
      </FormGroup>
      <FormGroup title="Delete product" description="Deletes the product and its website index. Delete its articles first.">
        <DeleteProduct id={product.id} name={product.name} />
      </FormGroup>
    </>
  );
}
