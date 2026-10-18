"use client";
import { useEffect, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getProductAction,
  pauseIndexingAction,
  saveProductSettingsAction,
  startIndexingAction,
} from "@/app/products/actions";
import type { ProductView } from "@/lib/products";
import type { WebsiteSettings } from "@/lib/schemas";
import { ErrorMessage, FormGroup, TextField } from "@/components/forms/fields";
import { CoverStylePicker } from "@/components/forms/cover-style-picker";
import { DEFAULT_COVER_STYLE } from "@/lib/agent/media/cover-styles";

export function ProductSettingsForm({
  initialProduct,
}: {
  initialProduct: ProductView;
}) {
  const [current, setCurrent] = useState(initialProduct);
  const id = current.id;
  const [name, setName] = useState(initialProduct.name);
  const [settings, setSettings] = useState(initialProduct.settings);
  const [priority, setPriority] = useState(settings.priorityPages.join("\n"));
  const [excluded, setExcluded] = useState(settings.excludedPages.join("\n"));
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string>();
  const indexing = current.index === "running";
  // The server indexes in the background; while it does, the page watches its progress.
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(async () => {
      const result = await getProductAction(id).catch(() => undefined);
      if (!result?.data) return;
      setCurrent(result.data);
      if (result.data.index !== "running") setPausing(false);
    }, 2000);
    return () => clearInterval(timer);
  }, [indexing, id]);
  const settingsDirty =
    current &&
    (name !== current.name ||
      JSON.stringify(settings) !== JSON.stringify(current.settings) ||
      priority !== current.settings.priorityPages.join("\n") ||
      excluded !== current.settings.excludedPages.join("\n"));
  function update<K extends keyof WebsiteSettings>(
    key: K,
    value: WebsiteSettings[K],
  ) {
    setSettings((s) => ({ ...s, [key]: value }));
    setMessage("");
  }
  async function save(event: React.SubmitEvent) {
    event.preventDefault();
    if (!id) return;
    setBusy(true);
    setError(undefined);
    try {
      const lines = (s: string) => [
        ...new Set(
          s
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
      const result = await saveProductSettingsAction(id, {
        name,
        settings: {
          ...settings,
          priorityPages: lines(priority),
          excludedPages: lines(excluded),
        },
      });
      if (result.error) setError(result.error);
      else if (result.data) {
        setCurrent(result.data);
        setName(result.data.name);
        setSettings(result.data.settings);
        setPriority(result.data.settings.priorityPages.join("\n"));
        setExcluded(result.data.settings.excludedPages.join("\n"));
        setMessage("Product settings saved.");
      }
    } catch {
      setError("Could not save your website settings.");
    } finally {
      setBusy(false);
    }
  }
  async function indexAction(call: () => ReturnType<typeof startIndexingAction>) {
    setError(undefined);
    try {
      const result = await call();
      if (result.error) setError(result.error);
      else if (result.data) setCurrent(result.data);
    } catch {
      setError("Could not reach the server. Reload the page and try again.");
    }
  }
  return (
    <div className="space-y-6">
      <form onSubmit={save} className="space-y-5">
        <fieldset disabled={busy || indexing} className="space-y-5">
          <FormGroup title="Website and brand">
            <TextField label="Product name" required value={name} onChange={setName} />
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label="Website URL"
                type="url"
                required
                value={settings.websiteUrl}
                onChange={(v) => update("websiteUrl", v)}
                placeholder="https://example.com"
                help="The site the articles are published on and link to."
              />
              <TextField
                label="Sitemap URL"
                type="url"
                value={settings.sitemapUrl}
                onChange={(v) => update("sitemapUrl", v)}
                placeholder="https://example.com/sitemap.xml"
              />
            </div>
            <TextField
              label="Brand, company or product name"
              value={settings.brandName}
              onChange={(v) => update("brandName", v)}
            />
            <TextField
              label="Product description"
              multiline
              value={settings.productDescription}
              onChange={(v) => update("productDescription", v)}
            />
            <TextField
              label="Target audience"
              multiline
              value={settings.targetAudience}
              onChange={(v) => update("targetAudience", v)}
            />
            <TextField
              label="Brand writing guidelines"
              multiline
              value={settings.writingGuidelines}
              onChange={(v) => update("writingGuidelines", v)}
              help="Voice, preferred terminology and substantiated brand experience the writer can use."
            />
          </FormGroup>
          <FormGroup title="Internal linking preferences">
            <TextField
              label="Priority pages"
              multiline
              value={priority}
              onChange={setPriority}
              help="Full URLs on this website, one per line. Relevant priority pages get a small ranking boost."
            />
            <TextField
              label="Never link to these pages"
              multiline
              value={excluded}
              onChange={setExcluded}
              help="Full URLs, one per line. Child paths are also excluded."
            />
          </FormGroup>
          <FormGroup
            title="Featured image style"
            description="The house style for this product's covers, illustrations and infographics."
          >
            <CoverStylePicker
              value={settings.coverStyle ?? DEFAULT_COVER_STYLE}
              onChange={(id) => update("coverStyle", id)}
            />
          </FormGroup>
          <Button disabled={busy} type="submit">
            {busy ? "Saving…" : "Save product settings"}
          </Button>
        </fieldset>
      </form>
      {current && (
        <FormGroup
          title="Website content index"
          description="Reads the home page, priority pages and the sitemap (up to 10 sitemaps), so the agents can link to your pages. Starts when the product is added and runs on the server. Page summaries and embeddings use your paid AI API."
        >
          <p className="text-sm">
            {current.indexedCount} pages indexed
            {current.indexedAt
              ? ` · Last indexed ${new Date(current.indexedAt).toLocaleDateString("en-US", { timeZone: "UTC" })}`
              : ""}
          </p>
          {indexing && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              {pausing
                ? "Pausing after the current page…"
                : current.indexRemaining
                  ? `Indexing: ${current.indexRemaining} pages left. You can leave this page.`
                  : "Reading the home page and sitemap…"}
            </p>
          )}
          {current.indexError && (
            <p className="break-words text-xs text-amber-700 dark:text-amber-400">
              {current.index === "failed" ? "Indexing failed" : "Some pages could not be indexed"}: {current.indexError}
            </p>
          )}
          {settingsDirty && (
            <p className="text-xs text-muted-foreground">
              Save your changes before indexing the website.
            </p>
          )}
          <div className="flex gap-2">
            {indexing ? (
              <Button
                variant="outline"
                disabled={pausing}
                onClick={() => {
                  setPausing(true);
                  void indexAction(() => pauseIndexingAction(id));
                }}
              >
                Pause indexing
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy || Boolean(settingsDirty)}
                onClick={() => indexAction(() => startIndexingAction(id))}
              >
                {current.index === "paused" ? "Resume indexing" : "Index website"}
              </Button>
            )}
          </div>
        </FormGroup>
      )}
      <ErrorMessage error={error} />
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  );
}
