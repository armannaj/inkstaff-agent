"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createProductAction } from "@/app/products/actions";
import { ErrorMessage, FormGroup, TextField } from "@/components/forms/fields";

export function NewProductForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await createProductAction({ name, websiteUrl });
      if (result.error) setError(result.error);
      else router.push(`/products/${result.data}`);
    } catch {
      setError("Could not add the product. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <FormGroup title="Add a product" description="Its name and website. Writing settings, the site index and publishing come next.">
        <fieldset disabled={busy} className="grid gap-5 sm:grid-cols-2">
          <TextField label="Name" required value={name} onChange={setName} placeholder="e.g. Acme Scheduler" />
          <TextField
            label="Website URL"
            type="url"
            required
            value={websiteUrl}
            onChange={setWebsiteUrl}
            placeholder="https://example.com"
          />
        </fieldset>
        <ErrorMessage error={error} />
        <Button type="submit" disabled={busy}>
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />} Add product
        </Button>
      </FormGroup>
    </form>
  );
}
