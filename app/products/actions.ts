"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  clearPublishingSettings,
  clearStorageSettings,
  createProduct,
  deleteProduct,
  getProduct,
  savePublishingSettings,
  saveProductSettings,
  saveStorageSettings,
} from "@/lib/products";
import { pauseIndexing, startIndexing } from "@/lib/site-index";

type ActionResult<T> = { data: T; error?: never } | { data?: never; error: string };

async function action<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { data: await run() };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues.map((issue) => issue.message).join("; ") };
    console.error("Product action failed", error);
    return {
      error:
        error instanceof Error && !/sqlite|query:|password/i.test(error.message)
          ? error.message.slice(0, 500)
          : "Could not update the product. Check the server log.",
    };
  }
}

const idSchema = z.number().int().positive();

async function loadProduct(id: number) {
  const product = await getProduct(id);
  if (!product) throw new Error("Product not found.");
  return product;
}

export async function createProductAction(input: { name: string; websiteUrl: string }) {
  return action(async () => {
    const id = await createProduct(input);
    // Indexing starts right away, so the site's pages are usually ready to link by the first article.
    startIndexing(id);
    revalidatePath("/products");
    return id;
  });
}

export async function saveProductSettingsAction(id: number, input: { name: string; settings: unknown }) {
  return action(async () => {
    const productId = idSchema.parse(id);
    await saveProductSettings(productId, input);
    revalidatePath("/products");
    revalidatePath(`/products/${productId}`);
    return loadProduct(productId);
  });
}

/** The product as its page shows it; the page polls this while the site is being indexed. */
export async function getProductAction(id: number) {
  return action(() => loadProduct(idSchema.parse(id)));
}

/** Starts indexing the product's site in the background: resuming a paused index, otherwise from scratch. */
export async function startIndexingAction(id: number) {
  return action(async () => {
    const productId = idSchema.parse(id);
    const product = await loadProduct(productId);
    startIndexing(productId, product.index !== "paused");
    return loadProduct(productId);
  });
}

/** Stops indexing after the current page. Resuming continues from where it stopped. */
export async function pauseIndexingAction(id: number) {
  return action(async () => {
    const productId = idSchema.parse(id);
    pauseIndexing(productId);
    return loadProduct(productId);
  });
}

/** Saves where the product's articles are published. The token is write-only and never sent back to the browser. */
export async function setPublishingSettingsAction(id: number, input: { endpointUrl: string; token: string }) {
  return action(async () => {
    const productId = idSchema.parse(id);
    await savePublishingSettings(productId, input);
    revalidatePath(`/products/${productId}`);
    return true;
  });
}

/** Removes the product's publishing settings, token included. Published articles stay where they are. */
export async function clearPublishingSettingsAction(id: number) {
  return action(async () => {
    const productId = idSchema.parse(id);
    await clearPublishingSettings(productId);
    revalidatePath(`/products/${productId}`);
    return true;
  });
}

/** Saves where the product's article images are stored. The secret key is write-only, like the publishing token. */
export async function setStorageSettingsAction(
  id: number,
  input: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicUrl: string },
) {
  return action(async () => {
    const productId = idSchema.parse(id);
    await saveStorageSettings(productId, input);
    revalidatePath(`/products/${productId}`);
    return true;
  });
}

/** Removes the product's image storage settings, secret key included. Images already uploaded stay in the bucket. */
export async function clearStorageSettingsAction(id: number) {
  return action(async () => {
    const productId = idSchema.parse(id);
    await clearStorageSettings(productId);
    revalidatePath(`/products/${productId}`);
    return true;
  });
}

export async function deleteProductAction(id: number) {
  return action(async () => {
    await deleteProduct(idSchema.parse(id));
    revalidatePath("/products");
    return true;
  });
}
