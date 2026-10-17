"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  indexProductPagesAction,
  saveProductSettingsAction,
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
  const [indexing, setIndexing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string>();
  const stop = useRef(false);
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );
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
  async function index(restart: boolean) {
    if (!id) return;
    stop.current = false;
    setIndexing(true);
    setError(undefined);
    try {
      let first = restart;
      do {
        const result = await indexProductPagesAction(id, first);
        first = false;
        if (result.error) {
          setError(result.error);
          break;
        }
        if (!result.data) break;
        setCurrent(result.data.product);
        setMessage(
          result.data.done
            ? "Website index is ready."
            : `${result.data.remaining} pages left to index…`,
        );
        if (result.data.done) break;
      } while (!stop.current);
    } catch {
      setError("Indexing stopped. Resume to continue from the saved page.");
    } finally {
      setIndexing(false);
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
          description="Reads the home page, priority pages and the sitemap (up to 10 sitemaps), so the agents can link to your pages. Page summaries and embeddings use your paid AI API."
        >
          <p className="text-sm">
            {current.indexedCount} pages indexed
            {current.indexedAt
              ? ` · Last indexed ${new Date(current.indexedAt).toLocaleDateString("en-US", { timeZone: "UTC" })}`
              : ""}
          </p>
          {current.indexError && (
            <p className="break-words text-xs text-amber-700 dark:text-amber-400">
              Some pages could not be indexed: {current.indexError}
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
                onClick={() => {
                  stop.current = true;
                  setMessage("Pausing after the current page…");
                }}
              >
                Pause indexing
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy || Boolean(settingsDirty)}
                  onClick={() =>
                    index(
                      !["indexing", "processing"].includes(current.indexStatus),
                    )
                  }
                >
                  {["indexing", "processing"].includes(current.indexStatus)
                    ? "Resume indexing"
                    : "Index website"}
                </Button>
              </>
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
