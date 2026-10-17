"use client";

import { Loader2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import {
  clearPublishingSettingsAction,
  setPublishingSettingsAction,
} from "@/app/products/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** What the browser may know about a product's publishing settings: everything except the token. */
export type PublishingSummary = {
  endpointUrl: string;
  mediaBucket: string;
  mediaPublicUrl: string;
  hasToken: boolean;
};

/**
 * Where this product's articles are published: an Outrank-compatible endpoint and the S3-compatible bucket (with its
 * public URL) that holds the article images.
 */
export function PublishingSettings({ productId, initial }: { productId: number; initial: PublishingSummary | null }) {
  const [form, setForm] = useState({
    endpointUrl: initial?.endpointUrl ?? "",
    token: "",
    mediaBucket: initial?.mediaBucket ?? "",
    mediaPublicUrl: initial?.mediaPublicUrl ?? "",
  });
  const [hasToken, setHasToken] = useState(initial?.hasToken ?? false);
  const [configured, setConfigured] = useState(!!initial);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string }>();
  const [pending, startTransition] = useTransition();
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function save() {
    setMessage(undefined);
    startTransition(async () => {
      const result = await setPublishingSettingsAction(productId, form);
      if (result.error) return setMessage({ tone: "error", text: result.error });
      setHasToken(true);
      setConfigured(true);
      setForm((f) => ({ ...f, token: "" }));
      setMessage({ tone: "info", text: "Saved. Articles for this product can now be published." });
    });
  }

  function clear() {
    if (!confirm("Remove the publishing settings, including the saved token?")) return;
    startTransition(async () => {
      const result = await clearPublishingSettingsAction(productId);
      if (result.error) return setMessage({ tone: "error", text: result.error });
      setHasToken(false);
      setConfigured(false);
      setForm({ endpointUrl: "", token: "", mediaBucket: "", mediaPublicUrl: "" });
      setMessage({ tone: "info", text: "Publishing settings removed." });
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        The editor&apos;s Publish button sends articles to this endpoint in Outrank&apos;s webhook format
        (publish_articles, then update_article for changes). Images are uploaded first to the bucket below and linked
        from its public URL. The storage keys are set once in the server environment (S3_ENDPOINT, S3_ACCESS_KEY_ID,
        S3_SECRET_ACCESS_KEY).
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="publish-endpoint">Publish API URL</Label>
          <Input
            id="publish-endpoint"
            type="url"
            placeholder="https://example.com/api/outrank"
            value={form.endpointUrl}
            onChange={set("endpointUrl")}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="publish-token">Bearer token</Label>
          <Input
            id="publish-token"
            type="password"
            autoComplete="off"
            placeholder={hasToken ? "Saved. Leave empty to keep it." : "The endpoint's token"}
            value={form.token}
            onChange={set("token")}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="media-bucket">Media bucket</Label>
            <Input id="media-bucket" value={form.mediaBucket} onChange={set("mediaBucket")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="media-url">Bucket&apos;s public URL</Label>
            <Input id="media-url" type="url" value={form.mediaPublicUrl} onChange={set("mediaPublicUrl")} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The bucket must be publicly readable at that URL (for Cloudflare R2: connect a custom domain in the bucket&apos;s
          settings). If the site uses Next.js images, add the host to its images.remotePatterns.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            Save
          </Button>
          {configured && (
            <Button type="button" variant="ghost" disabled={pending} onClick={clear}>
              Remove
            </Button>
          )}
        </div>
      </form>
      {message && (
        <p className={message.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
