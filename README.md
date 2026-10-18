# Inkstaff

A team of AI agents that researches, plans, writes, illustrates and reviews blog articles, and publishes them to your
site.

You give it a keyword. A **Director** agent sends the work through a team of five agents until the article passes
review:

- **Research** looks at what ranks for the keyword: the results page and Google's AI overview, the ranking pages,
  YouTube videos and keyword data. It hands back a research dossier.
- **Editor** decides what the page must be to become the best result: its angle, outline, sources, media, title and
  meta description.
- **Writer** writes the article the plan describes.
- **Graphics** takes screenshots, draws illustrations, infographics and the cover, and places videos.
- **Reviewer** judges the whole article against what ranks today and the sources it was written from. It reports
  issues with a severity and an owner.

Code, not the models, enforces the rules:

- **Spending:** a hard budget per article, plus limits on searches, page reads and images.
- **Review:** the Director can't finish while a critical or major issue is open, and the number of review rounds is
  capped.
- **Facts and links:** numbers no read source contains are flagged, and links to pages nobody read are removed.

The agents run in the background on the server. Every step is saved, so you can close the page, and a restart picks up
where it stopped. While they work, you can watch the log, pause, stop, or send them a note. When they finish, you can
edit, redraw images and publish.

## Setup

Requirements: Node.js 22 or later.

```bash
npm install
cp .env.example .env.local   # then fill in the required keys
npm run dev
```

Open http://localhost:3000, add a product (your site), then start an article.

The database is a SQLite file (`data/inkstaff.db` by default; set `DATABASE_PATH` to change it). It is created, with
its tables, the first time it is used.

### Keys

| Variable | Needed for |
| --- | --- |
| `OPENROUTER_API_KEY` | Required. Every model call: agents, vision, images, embeddings. |
| `DFS_AUTH`, or `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` | Required. Google and YouTube results, keyword data, video transcripts. `DFS_AUTH` is the Basic auth value (base64 of `login:password`). |
| `SCREENSHOTENGINE_API_KEY` | Optional. Screenshots, and reading pages drawn by JavaScript. |
| `GSC_CREDENTIALS_PATH` | Optional. Your site's Google Search Console data (a service account key file). |

Everything else (the model each agent uses, reasoning effort, budgets and limits, the search market) has a default and
can be changed in `.env.local`. `.env.example` lists every variable.

### Cost

Each article makes many billed calls: models through OpenRouter, searches through DataForSEO, and image generation. The
article's page shows what it cost, by agent. `ARTICLE_BUDGET_USD` (default $15) stops an article when it is reached.

## Products

Every article is written for a product, set up under **Products**:

- **Website and brand:** the site, its description, audience and writing guidelines, which the agents follow.
- **Website index:** reads the home page, priority pages and sitemap, so the agents can link to your own pages. It
  starts in the background when the product is added. An article started before it finishes gets fewer internal links.
- **Featured image style:** the house style for covers, illustrations and infographics.
- **Publishing:** a webhook on the product's blog (`publish_articles`, then `update_article` for changes) with a bearer
  token. Articles are published at `/blog/<slug>` on the product's site. See [Publishing API](#publishing-api).
- **Image storage (S3):** the S3-compatible bucket (Cloudflare R2, AWS S3, MinIO) the article images are uploaded to:
  its endpoint, region, access keys, bucket and public URL. Set per product, not in the environment.

## Publishing API

To publish straight to your site, your site needs one endpoint that receives articles. Inkstaff doesn't host your blog:
it sends each article to that endpoint, and your site stores and renders it. Put the endpoint's URL and token in the
product's **Publishing** settings.

### Request

When you click **Publish** or **Update post** in the editor, Inkstaff sends a request like this:

```http
POST <your endpoint URL>
Authorization: Bearer <the token saved in the product's Publishing settings>
Content-Type: application/json
```

- The endpoint must use HTTPS.
- Any 2xx response counts as success. Inkstaff keeps the first 500 characters of the response body for reference.
- Any other status shows as an error in the editor, together with the first 200 characters of the body. Nothing is
  marked as published, and you can click Publish again.
- Inkstaff gives up after 60 seconds.
- Inkstaff doesn't retry on its own and doesn't follow up with other calls.

There are two kinds of event, named by `event_type`.

**`publish_articles`**: the article's first publish. `data.articles` is an array; Inkstaff sends one article per
request, but handle any number.

```json
{
  "event_type": "publish_articles",
  "timestamp": "2026-10-18T14:03:12.481Z",
  "data": {
    "articles": [
      {
        "id": "3f2b8c1e-9d4a-4e7b-a1c2-5b6d7e8f9a0b",
        "title": "How to Schedule Social Media Posts as a Solo Founder",
        "content_markdown": "## Why scheduling matters\n\nPosting by hand every day…\n\n![A weekly posting calendar](https://media.example.com/how-to-schedule-social-media-posts/a-weekly-posting-calendar-1a2b3c4d.webp)\n\n## Frequently asked questions\n\n### How often should I post?\n\nThree to five times a week…",
        "content_html": "<h2>Why scheduling matters</h2>\n<p>Posting by hand every day…</p>\n<p><img src=\"https://media.example.com/how-to-schedule-social-media-posts/a-weekly-posting-calendar-1a2b3c4d.webp\" alt=\"A weekly posting calendar\"></p>\n…",
        "meta_description": "A step-by-step way to plan and schedule a month of social posts in one afternoon, with free and paid tools compared.",
        "image_url": "https://media.example.com/how-to-schedule-social-media-posts/cover-5e6f7a8b.webp",
        "slug": "how-to-schedule-social-media-posts",
        "tags": [],
        "created_at": "2026-10-18T14:03:12.481Z"
      }
    ]
  }
}
```

**`update_article`**: every later publish of the same article. Inkstaff also sends this instead of `publish_articles`
when an article rewrites a post that is already on your blog (**Rewrite an existing post** on the New article form). The
article object is the same, except that it is a single `data.article` (not an array) and has no `created_at`.

```json
{
  "event_type": "update_article",
  "timestamp": "2026-10-20T09:41:55.120Z",
  "data": {
    "article": {
      "id": "3f2b8c1e-9d4a-4e7b-a1c2-5b6d7e8f9a0b",
      "title": "How to Schedule Social Media Posts as a Solo Founder",
      "content_markdown": "## Why scheduling matters\n\n…",
      "content_html": "<h2>Why scheduling matters</h2>\n…",
      "meta_description": "A step-by-step way to plan and schedule a month of social posts in one afternoon, with free and paid tools compared.",
      "image_url": "https://media.example.com/how-to-schedule-social-media-posts/cover-5e6f7a8b.webp",
      "slug": "how-to-schedule-social-media-posts",
      "tags": []
    }
  }
}
```

### Fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string (UUID) | Inkstaff's ID for the article. It stays the same across updates of that article. |
| `title` | string | The post's H1. The body never contains an H1, so render the title yourself. |
| `content_markdown` | string | The body as GitHub-flavored Markdown (tables, lists, links), starting at the first `##` section. |
| `content_html` | string | The same body as HTML. Use whichever of the two your site renders. |
| `meta_description` | string | For the page's `<meta name="description">`. |
| `image_url` | string or `null` | The cover image as an absolute URL, or `null` when there is no cover. The cover is not in the body. |
| `slug` | string | The post's URL path. Inkstaff links to the post as `https://<your site>/blog/<slug>`. The slug never changes once published. |
| `tags` | string[] | Always empty for now. |
| `created_at` | ISO 8601 string | Sent with `publish_articles` only. |

About the body:

- **Images** are WebP files in the product's S3 bucket, linked by absolute URLs under the bucket's public URL. If the
  site uses `next/image`, add that host to `images.remotePatterns`. When an update replaces an image, Inkstaff deletes
  the old file from the bucket after your endpoint accepts the update.
- **Videos** are YouTube `<iframe>` embeds, in both `content_markdown` and `content_html`. If your Markdown renderer
  strips raw HTML, allow iframes from `https://www.youtube.com/embed/`, or render `content_html` instead.
- **Internal links** point to pages on your own site; external links point to the sources the article cites.

### What your endpoint must do

1. Reject requests whose `Authorization` header isn't exactly `Bearer <token>` with a 401. Use a constant-time
   comparison.
2. Save the post **by slug, as an upsert**, for both events:
   - `update_article` for a rewritten post carries an `id` your site has never seen, under the slug of the post it
     replaces.
   - If an earlier `publish_articles` reached your site but its response was lost, the next Publish sends
     `publish_articles` again, with the same `id`. The slug is also the same, unless you edited it in the SEO tab in
     between.
3. Store `title`, the body, `meta_description`, `image_url`, `created_at` on first publish, and an updated-at time.
4. Make the post visible at `/blog/<slug>`, and clear any cache of that page and of the blog's index.
5. Reply with a 2xx and a short JSON body, for example `{"ok": true, "url": "https://example.com/blog/<slug>"}`.

### Prompt for your site's coding agent

Paste this into the AI coding agent (Claude Code, Cursor, …) working in your blog's codebase. It is written to work
on its own, with no access to this repository.

````text
Build an HTTPS webhook endpoint in this codebase that receives blog posts from Inkstaff, an AI writing tool, and
publishes them on this site's blog. First look at how this project stores and renders content (database, CMS, MDX
files, …), and follow its existing conventions, framework and data layer. Don't add a new stack.

Endpoint: POST /api/blog/webhook (or the idiomatic equivalent for this framework).

Authentication: every request has the header `Authorization: Bearer <token>`. Read the expected token from a new
environment variable, BLOG_WEBHOOK_TOKEN, and compare it in constant time. Reply 401 when it is missing or wrong.
Document the variable wherever this project documents its environment variables.

The body is JSON, with one of two shapes:

1. {"event_type": "publish_articles", "timestamp": ISO-8601,
    "data": {"articles": [Article & {"created_at": ISO-8601}]}}
   Usually one article, but handle any number.
2. {"event_type": "update_article", "timestamp": ISO-8601, "data": {"article": Article}}

Article = {
  "id": string (UUID),            // the sender's ID; the same across updates of one article
  "title": string,                // the post's H1; the body has no H1
  "content_markdown": string,     // GitHub-flavored Markdown body, starting at an H2
  "content_html": string,         // the same body as HTML
  "meta_description": string,
  "image_url": string | null,     // absolute URL of the cover image; not repeated in the body
  "slug": string,                 // URL path: the post lives at /blog/<slug>
  "tags": string[]                // currently always empty
}

Validate the body (reply 400 with a short message when it is invalid; ignore unknown fields). Reply 400 for an unknown
event_type.

Save each article as an UPSERT KEYED BY SLUG, for both event types. An update may carry an id this site has never
seen (it replaces an existing post under that post's slug), and a publish may arrive twice for the same slug. Store
the title, the body, meta_description, image_url (as the cover/featured image), the sender's id, created_at (first
publish only; otherwise keep the existing value, or use the timestamp for a new row) and an updated_at. Posts
published this way are public right away.

Render the body from content_markdown with this project's Markdown renderer, if it has one (with GitHub-flavored
Markdown support), or else from content_html. The body can contain YouTube embeds as raw
<iframe src="https://www.youtube.com/embed/..."> HTML. Allow iframes from that origin only, and sanitize everything
else. Images in the body and the cover are absolute URLs on an external host (the media bucket). If the site uses
next/image or a similar optimizer, allow that host. Render the title as the page's H1, use meta_description for
<meta name="description">, and use image_url for the Open Graph image.

Make the post visible at /blog/<slug>, and list it on the blog's index page if this site has one. After saving,
revalidate or purge any cached version of /blog/<slug> and of the blog's index.

Reply 200 with {"ok": true, "url": "<absolute URL of the post>"} for update_article, or
{"ok": true, "urls": [...]} for publish_articles. Reply 5xx only for real server errors; the sender shows any non-2xx
response to the user, and the user retries by hand. Respond within 60 seconds.

Add tests for: a missing or wrong token (401), an invalid body (400), publish creating a post, publishing the same
slug twice making one post, update_article with an unknown id updating the post with that slug, and update_article
for a slug that doesn't exist creating it. Finally, tell me the full endpoint URL to configure and how to set
BLOG_WEBHOOK_TOKEN.
````

Then, in Inkstaff, open the product, set **Publish API URL** to that endpoint and **Bearer token** to the same value
as `BLOG_WEBHOOK_TOKEN`, and set up **Image storage (S3)** for the article images.

## Development

```bash
npm test             # the agents' tests (fake providers, no API calls)
npm run typecheck
npm run lint
npm run db:generate  # after changing db/schema.ts: writes a migration to drizzle/
```

The agents live in `lib/agent/`:

- `agents.ts` defines the team.
- `director.ts` routes the work.
- `harness.ts` runs one agent turn.
- `engine.ts` and `runner.ts` run articles in the background.
- `tools/` holds what each agent can do.

The pages are in `app/`.

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a service for others, you must make
its source code available to them under the same license.
