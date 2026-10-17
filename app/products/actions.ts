"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  clearPublishingSettings,
  createProduct,
  deleteProduct,
  getProduct,
  savePublishingSettings,
  saveProductSettings,
} from "@/lib/products";
import { indexStep } from "@/lib/site-index";

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

export async function indexProductPagesAction(id: number, restart = false) {
  return action(async () => {
    const productId = idSchema.parse(id);
    const result = await indexStep(productId, z.boolean().parse(restart));
    if (result.done) revalidatePath(`/products/${productId}`);
    return { ...result, product: await loadProduct(productId) };
  });
}

/** Saves where the product's articles are published. The token is write-only and never sent back to the browser. */
export async function setPublishingSettingsAction(
  id: number,
  input: { endpointUrl: string; token: string; mediaBucket: string; mediaPublicUrl: string },
) {
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

export async function deleteProductAction(id: number) {
  return action(async () => {
    await deleteProduct(idSchema.parse(id));
    revalidatePath("/products");
    return true;
  });
}
