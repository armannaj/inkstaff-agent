"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteProductAction } from "@/app/products/actions";

export function DeleteProduct({ id, name }: { id: number; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    if (!confirm(`Delete "${name}" and its website index?`)) return;
    setBusy(true);
    const result = await deleteProductAction(id);
    setBusy(false);
    if (result.error) setError(result.error);
    else router.push("/products");
  }
  return (
    <div className="space-y-2">
      <Button variant="destructive" disabled={busy} onClick={remove}>
        <Trash2Icon /> Delete product
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
