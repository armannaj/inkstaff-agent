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
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Optional. Publishing: S3-compatible storage for article images (Cloudflare R2, AWS S3, MinIO). |

Everything else (the model each agent uses, reasoning effort, budgets and limits, the search market) has a default and
can be changed in `.env.local`. `.env.example` lists every variable.

### Cost

Each article makes many billed calls: models through OpenRouter, searches through DataForSEO, and image generation. The
article's page shows what it cost, by agent. `ARTICLE_BUDGET_USD` (default $15) stops an article when it is reached.

## Products

Every article is written for a product, set up under **Products**:

- **Website and brand:** the site, its description, audience and writing guidelines, which the agents follow.
- **Website index:** reads the home page, priority pages and sitemap, so the agents can link to your own pages.
- **Featured image style:** the house style for covers, illustrations and infographics.
- **Publishing:** an Outrank-compatible webhook (`publish_articles`, then `update_article` for changes) with a bearer
  token, and the bucket and public URL for its images. Articles are published at `/blog/<slug>` on the product's site.

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
