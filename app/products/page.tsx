import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { NewProductForm } from "@/components/products/new-product";
import { listProducts } from "@/lib/products";

export const metadata: Metadata = { title: "Products" };

export default function ProductsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-5 py-8 sm:px-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every article is written for one of your products: its website, audience and writing guidelines, the pages it
          can link to, and where it is published.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading products…</p>}>
        <ProductList />
      </Suspense>
      <NewProductForm />
    </main>
  );
}

async function ProductList() {
  await connection();
  const products = await listProducts();
  if (!products.length) return <p className="text-sm text-muted-foreground">No products yet. Add your first one below.</p>;
  return (
    <ul className="divide-y overflow-hidden rounded-xl border" aria-label="Products">
      {products.map((product) => (
        <li key={product.id}>
          <Link href={`/products/${product.id}`} className="flex flex-wrap items-baseline justify-between gap-2 p-4 hover:bg-muted/40">
            <span className="font-medium">{product.name}</span>
            <span className="text-sm text-muted-foreground">{new URL(product.settings.websiteUrl).host}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
