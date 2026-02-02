# Reading Log

Cloudflare Worker that stores a curated reading list in KV and exposes JSON, Markdown, and RSS endpoints.

## Install / Prereqs

- Cloudflare account
- Node.js 18+
- Wrangler CLI

Install Wrangler:
```bash
npm install -g wrangler
```

Login:
```bash
wrangler login
```

## Endpoints

### GET `/reading`
Returns JSON list of items (newest first).

Query params:
- `limit` (default `5`, max `20`)

### GET `/reading/markdown`
Returns a Markdown list for README embedding.

Query params:
- `limit` (default `5`, max `20`)

### GET `/reading/rss`
Returns an RSS feed.

Query params:
- `limit` (default `5`, max `20`)

### POST `/reading/add`
Adds an item. Requires auth.

Headers:
- `Authorization: Bearer $READING_TOKEN` or `X-Reading-Token: $READING_TOKEN`

JSON body:
```json
{
  "title": "Article title",
  "url": "https://example.com/article",
  "source": "Optional publication",
  "added_at": "Optional ISO timestamp"
}
```

## Truncation Rules (Markdown list)

- If title length is **85+**, truncate to **80** characters and append `…`.
- If title length is **84 or less**, display the full title.

## Setup

1. Create a KV namespace and bind it in `wrangler.toml` as `READING_KV`.
   ```bash
   wrangler kv namespace create READING_KV
   wrangler kv namespace create READING_KV --preview
   ```
2. Add the KV IDs to `wrangler.toml`.
3. Set the write token:
   ```bash
   wrangler secret put READING_TOKEN
   ```
4. Optional metadata (set in `wrangler.toml` under `[vars]` or via secrets):
   ```bash
   wrangler secret put READING_SITE_TITLE
   wrangler secret put READING_SITE_URL
   wrangler secret put READING_MORE_URL
   ```
5. Deploy:
   ```bash
   wrangler deploy
   ```

## Example: add an item

```bash
curl -X POST https://YOUR_WORKER_URL/reading/add \
  -H "Authorization: Bearer $READING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Example title","url":"https://example.com","source":"Example"}'
```

## README Integration (optional)

If your GitHub README contains:
```md
<!-- READING-LOG:START -->
...
<!-- READING-LOG:END -->
```

You can populate it with the Markdown endpoint:
```
https://YOUR_WORKER_URL/reading/markdown?limit=5
```
