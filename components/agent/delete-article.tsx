"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteAgentArticleAction } from "@/app/articles/actions";

export function DeleteAgentArticle({ id, title, published }: { id: string; title: string; published: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!confirm(`Delete "${title}"?${published ? " The published post stays on its site." : ""}`)) return;
    setBusy(true);
    const result = await deleteAgentArticleAction(id);
    setBusy(false);
    if (result.error) alert(result.error);
    else router.refresh();
  }
  return (
    <Button size="sm" variant="ghost" disabled={busy} onClick={remove} aria-label={`Delete ${title}`}>
      <Trash2Icon />
    </Button>
  );
}
