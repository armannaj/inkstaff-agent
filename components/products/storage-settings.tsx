"use client";

import { Loader2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { clearStorageSettingsAction, setStorageSettingsAction } from "@/app/products/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** What the browser may know about a product's image storage: everything except the secret key. */
export type StorageSummary = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  bucket: string;
  publicUrl: string;
  hasSecret: boolean;
};

const EMPTY = { endpoint: "", region: "auto", accessKeyId: "", secretAccessKey: "", bucket: "", publicUrl: "" };

/** The S3-compatible bucket (Cloudflare R2, AWS S3, MinIO) this product's article images are uploaded to. */
export function StorageSettings({ productId, initial }: { productId: number; initial: StorageSummary | null }) {
  const [form, setForm] = useState(initial ? { ...EMPTY, ...initial, secretAccessKey: "" } : EMPTY);
  const [hasSecret, setHasSecret] = useState(initial?.hasSecret ?? false);
  const [configured, setConfigured] = useState(!!initial);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string }>();
  const [pending, startTransition] = useTransition();
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function save() {
    setMessage(undefined);
    startTransition(async () => {
      const { endpoint, region, accessKeyId, secretAccessKey, bucket, publicUrl } = form;
      const result = await setStorageSettingsAction(productId, { endpoint, region, accessKeyId, secretAccessKey, bucket, publicUrl });
      if (result.error) return setMessage({ tone: "error", text: result.error });
      setHasSecret(true);
      setConfigured(true);
      setForm((f) => ({ ...f, secretAccessKey: "" }));
      setMessage({ tone: "info", text: "Saved. Article images will be uploaded to this bucket." });
    });
  }

  function clear() {
    if (!confirm("Remove the storage settings, including the saved secret key?")) return;
    startTransition(async () => {
      const result = await clearStorageSettingsAction(productId);
      if (result.error) return setMessage({ tone: "error", text: result.error });
      setHasSecret(false);
      setConfigured(false);
      setForm(EMPTY);
      setMessage({ tone: "info", text: "Storage settings removed." });
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        When an article is published, its cover and images are uploaded here first and linked from the bucket&apos;s
        public URL. Articles without images publish without it.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <div className="space-y-1">
            <Label htmlFor="s3-endpoint">S3 endpoint</Label>
            <Input
              id="s3-endpoint"
              type="url"
              placeholder="https://<account id>.r2.cloudflarestorage.com"
              value={form.endpoint}
              onChange={set("endpoint")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="s3-region">Region</Label>
            <Input id="s3-region" placeholder="auto" value={form.region} onChange={set("region")} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="s3-key">Access key ID</Label>
            <Input id="s3-key" autoComplete="off" value={form.accessKeyId} onChange={set("accessKeyId")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="s3-secret">Secret access key</Label>
            <Input
              id="s3-secret"
              type="password"
              autoComplete="off"
              placeholder={hasSecret ? "Saved. Leave empty to keep it." : undefined}
              value={form.secretAccessKey}
              onChange={set("secretAccessKey")}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="s3-bucket">Bucket</Label>
            <Input id="s3-bucket" value={form.bucket} onChange={set("bucket")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="s3-public-url">Bucket&apos;s public URL</Label>
            <Input
              id="s3-public-url"
              type="url"
              placeholder="https://media.example.com"
              value={form.publicUrl}
              onChange={set("publicUrl")}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The key needs permission to write and delete objects in the bucket. The bucket must be publicly readable at
          that URL (for Cloudflare R2: connect a custom domain in the bucket&apos;s settings). If the site uses Next.js
          images, add the host to its images.remotePatterns.
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
