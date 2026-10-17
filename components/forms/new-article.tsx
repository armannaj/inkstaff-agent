"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createAgentArticleAction } from "@/app/articles/actions";
import { DEFAULT_INPUT, type ArticleInput } from "@/lib/schemas";
import {
  ErrorMessage,
  FormGroup,
  SelectField,
  TextField,
  Toggle,
} from "./fields";

/** Values passed in the URL. */
export type ArticlePrefill = {
  productId?: number;
  primaryKeyword?: string;
  additionalKeywords?: string[];
  targetAudience?: string;
};

export function NewArticleForm({
  products,
  configured,
  prefill = {},
}: {
  products: { id: number; name: string }[];
  configured: boolean;
  prefill?: ArticlePrefill;
}) {
  const router = useRouter();
  const [input, setInput] = useState<ArticleInput>(() => {
    const productId = products.find((p) => p.id === prefill.productId)?.id ?? products[0]?.id ?? 0;
    return {
      ...DEFAULT_INPUT,
      productId,
      primaryKeyword: prefill.primaryKeyword ?? "",
      targetAudience: prefill.targetAudience ?? "",
    };
  });
  const [keywords, setKeywords] = useState(
    (prefill.additionalKeywords ?? []).join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  function update<K extends keyof ArticleInput>(
    key: K,
    value: ArticleInput[K],
  ) {
    setInput((prev) => ({ ...prev, [key]: value }));
  }
  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await createAgentArticleAction({
        ...input,
        additionalKeywords: [
          ...new Set(
            keywords
              .split(/[,\n]/)
              .map((k) => k.trim())
              .filter(Boolean),
          ),
        ],
      });
      if (result.error) setError(result.error);
      else router.push(`/articles/${result.data}`);
    } catch {
      setError("Could not create the article. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!products.length) {
    return (
      <div className="rounded-lg border p-5 space-y-3">
        <p className="text-sm">
          Add a product before creating an article. Every article belongs to one
          of your products.
        </p>
        <Button asChild>
          <Link href="/products">Add a product</Link>
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      {!configured && (
        <ErrorMessage error="Add OPENROUTER_API_KEY and DFS_AUTH (or DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) to your server environment (.env.local) to enable generation." />
      )}
      <fieldset disabled={busy} className="space-y-5">
        <FormGroup
          title="What are you writing about?"
          description="Start with the topic your readers are searching for."
        >
          <TextField
            label="Primary keyword"
            required
            value={input.primaryKeyword}
            onChange={(v) => update("primaryKeyword", v)}
            placeholder="e.g. social media automation for solo founders"
          />
          <TextField
            label="Additional keywords"
            multiline
            value={keywords}
            onChange={setKeywords}
            placeholder="One keyword per line, or separate with commas"
            help="Optional. Add as many related keywords as you need."
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <SelectField
              label="Article type"
              value={input.type}
              onChange={(v) => update("type", v)}
              options={["article", "listicle"]}
            />
            <SelectField
              label="Product"
              value={String(input.productId)}
              onChange={(v) => update("productId", Number(v))}
              options={[
                ...products.map((w) => [String(w.id), w.name] as const),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <SelectField
              label="Goal"
              value={input.goal}
              onChange={(v) => update("goal", v)}
              options={[
                ["auto", "Auto (agents decide)"],
                ["traffic", "Rank & traffic · the product stays in the background"],
                ["signups", "Sign-ups · readers it suits try the product"],
                ["awareness", "Awareness · readers remember the product"],
              ]}
            />
            <p className="text-xs text-muted-foreground">
              What success means for this article. Every goal includes ranking for the keyword; this sets how much the
              article works for the product.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            <Link
              href={
                input.productId ? `/products/${input.productId}` : "/products"
              }
              className="underline underline-offset-4"
            >
              Manage product writing settings
            </Link>{" "}
            to save your brand guidelines and discover internal links.
          </p>
          <TextField
            label="Rewrite an existing post"
            type="url"
            value={input.rewriteUrl}
            onChange={(v) => update("rewriteUrl", v.trim())}
            placeholder="e.g. https://example.com/blog/my-post"
            help="Optional. The address of a post already on this product's blog. The article is researched and written new, with that post as the starting point, and publishing replaces the post at the same address instead of adding a new one."
          />
        </FormGroup>
        <FormGroup
          title="Your original material"
          description="What only you can add: your data, results, experiments, customer stories, examples or opinions. It is what makes the article better than the pages that rank today."
        >
          <TextField
            label="Material (optional)"
            multiline
            value={input.ownerMaterial}
            onChange={(v) => update("ownerMaterial", v)}
            placeholder="e.g. We analyzed 1,200 scheduled posts from our users: threads posted at 9am got 2x replies. Our onboarding data shows most users connect X before LinkedIn."
            help="Used as first-party evidence and quoted only as written. Up to 8,000 characters."
          />
        </FormGroup>
        <FormGroup title="Content settings">
          <TextField
            label="Target audience"
            value={input.targetAudience}
            onChange={(v) => update("targetAudience", v)}
            placeholder="Uses your website audience when left blank"
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <SelectField
              label="Article length"
              value={input.length}
              onChange={(v) => update("length", v)}
              options={[
                ["auto", "Auto · as much as the topic needs"],
                ["short", "Short · 800–1,200 words"],
                ["medium", "Medium · 1,500–2,200 words"],
                ["long", "Long · 2,500–4,000 words"],
                ["custom", "Custom word count"],
              ]}
            />
            {input.length === "custom" && (
              <TextField
                label="Target word count"
                type="number"
                value={String(input.customWordCount)}
                onChange={(v) => update("customWordCount", Number(v))}
                help="300–8,000 words"
              />
            )}
            <SelectField
              label="Tone"
              value={input.tone}
              onChange={(v) => update("tone", v)}
              options={[
                "auto",
                "conversational",
                "professional",
                "technical",
                "friendly",
                "opinionated",
                "educational",
              ]}
            />
            <SelectField
              label="Reading level"
              value={input.readingLevel}
              onChange={(v) => update("readingLevel", v)}
              options={[
                ["auto", "Auto (agents decide)"],
                "general",
                "beginner",
                "intermediate",
                "expert",
              ]}
            />
          </div>
          <Toggle
            label="Write in first person"
            value={input.firstPerson}
            onChange={(v) => update("firstPerson", v)}
            help="Uses first person for reasoning and opinions. Never invents personal experience."
          />
          <div className="space-y-1.5">
            <SelectField
              label="Similar or competing products"
              value={input.mentionCompetitors}
              onChange={(v) => update("mentionCompetitors", v)}
              options={[
                ["auto", "Agents decide"],
                ["allowed", "Allowed"],
                ["not_allowed", "Not allowed"],
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {input.mentionCompetitors === "not_allowed"
                ? input.type === "listicle"
                  ? "A list of tools usually needs other products: with this setting, none can be named."
                  : "Other products won't be named; use this for articles about your own product."
                : input.mentionCompetitors === "allowed"
                  ? "Other products may be named and compared."
                  : "Named when the search calls for it, such as alternatives, comparisons and best-of lists."}
            </p>
          </div>
        </FormGroup>
        <FormGroup
          title="Links"
          description="Counts are upper targets. Links are included only when they help the reader."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            {(["internalLinks", "externalLinks"] as const).map((key) => (
              <SelectField
                key={key}
                label={
                  key === "internalLinks" ? "Internal links" : "External links"
                }
                value={String(input[key])}
                onChange={(v) => update(key, v === "auto" ? "auto" : Number(v))}
                options={[
                  "auto",
                  ...Array.from({ length: 21 }, (_, i) => String(i)),
                ]}
              />
            ))}
          </div>
        </FormGroup>
        <FormGroup
          title="Media"
          description="Every article gets a cover image with its headline. Images, screenshots, infographics and relevant YouTube videos are added where they help the reader."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <SelectField
              label="Image style"
              value={input.imageStyle}
              onChange={(v) => update("imageStyle", v)}
              options={[
                ["auto", "Auto (agents decide)"],
                "sketch",
                "realistic",
                "illustration",
              ]}
            />
            <SelectField
              label="Number of images"
              value={String(input.imageCount)}
              onChange={(v) =>
                update("imageCount", v === "auto" ? "auto" : Number(v))
              }
              options={[["auto", "Auto (agents decide)"], "1", "2", "3", "4", "5"]}
            />
          </div>
        </FormGroup>
      </fieldset>
      <ErrorMessage error={error} />
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5">
        <p className="max-w-md text-xs text-muted-foreground">
          Generation uses your paid AI and search APIs. The agents work in the background on the server; you can close
          the page.
        </p>
        <Button type="submit" disabled={busy || !configured}>
          {busy ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <ArrowRightIcon />
          )}{" "}
          Generate article
        </Button>
      </div>
    </form>
  );
}
