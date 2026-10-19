import { authRoute, equalSecret, sameOrigin, sessionId } from "./auth.ts";
import { fetchTitle } from "./title.ts";
import { readJson } from "./body.ts";

export interface Env extends Omit<Cloudflare.Env, "AUTH_ORIGIN" | "AUTH_LIMITER"> {
  READING_TOKEN?: string;
  AUTH_ORIGIN: string;
  SETUP_TOKEN?: string;
  AUTH_LIMITER?: RateLimit;
  READING_MORE_URL?: string;
  READING_SITE_TITLE?: string;
  READING_SITE_URL?: string;
}

type ReadingItem = {
  id: string;
  title: string;
  url: string;
  added_at: string;
};

const KV_KEY = "reading-items";
const MAX_ITEMS = 100;
// The README embed shows a short teaser; the site, feed, and API serve the full history.
const README_LIMIT = 5;
const HISTORY_LIMIT = MAX_ITEMS;
const MAX_LIMIT = MAX_ITEMS;
const TRUNCATE_THRESHOLD = 85;
const TRUNCATE_TO = 80;
const FAVICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAtGVYSWZJSSoACAAAAAYAEgEDAAEAAAABAAAAGgEFAAEAAABWAAAAGwEFAAEAAABeAAAAKAEDAAEAAAACAAAAEwIDAAEAAAABAAAAaYcEAAEAAABmAAAAAAAAAEgAAAABAAAASAAAAAEAAAAGAACQBwAEAAAAMDIxMAGRBwAEAAAAAQIDAACgBwAEAAAAMDEwMAGgAwABAAAA//8AAAKgBAABAAAAgAAAAAOgBAABAAAAgAAAAAAAAABKviP0AAACuElEQVR4nO3dMW4aURRA0RnCSOzAhVcQidaNF+AFuLDkcgq3lBFVhJIukheQ6lOzCS/ArZXaiMZQuLY0CZMdvIn1DZnh3tM+gW24+tI8wBSFJEmSJEmSJEmSJEmSJEk6BWVxYqqqaqN50zQn9zfnGGXdWoNnAHAGAGcAcAYAZwBwBgB3itfE4R4g13a7DednZ2eDekw9AeAMAM4A4AwAzgDgDADOAODGBcxkMgnnb29v4Xw+nxenxBMAzgDgDADOAOAMAM4A4AwAbnB7gNFoFL7ev9/vw9vf3t6G85RSkaOu6/D3Syn16v0CngBwBgBnAHAGAGcAcAYAZwBwg9sDdF3nLxaLcL5er7N+furYE9R1XQyJJwCcAcAZAJwBwBkAnAHAGQBcr16bPtLn/8tD3n/dsQe4vLwM53d3d0d9TjwB4AwAzgDgDADOAOAMAM4A4Hq3B6iq6nc0n81mn6L5/f191s8vy/ghadu8NcTFxUU4f3x8dA+g4zEAOAOAMwA4A4AzADgDgOvd5wKapgmv819fX8Pbn5+ff43mV1dX33Le918eeE9wbJ4AcAYAZwBwBgBnAHAGAGcAcP9jD3DQC+XdbvczmqeUvufcf5t5oT+dTnPfD/Chj58nAJwBwBkAnAHAGQCcAcAZANx4aNf5T09P4bxpml3RY2XH+wmOzRMAzgDgDADOAOAMAM4A4AwA7hB7gDLze/WyXk/fbDZfovnLy8uPIk/ZMW+H9LkBTwA4A4AzADgDgDMAOAOAMwC4fr04/Q+69gjL5TLcbbRt+yfzV2gP+f8Dur5vIKX0oc+ZJwCcAcAZAJwBwBkAnAHAGQDc4PYAQ99TPDw8hLd/fn4O5zc3N+F8tVq96zn1BIAzADgDgDMAOAOAMwA4A4BzD9Az19fXv6L5eDz+HM3dA+hdDADOAOD+AmdVf9wMHp+YAAAAAElFTkSuQmCC";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path.startsWith("/auth/")) {
      if (request.method === "POST" && env.AUTH_LIMITER &&
        !(await env.AUTH_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "local" })).success) {
        return jsonResponse({ error: "Too many attempts. Please try again in a minute." }, 429);
      }
      try { return await authRoute(request, env, path); }
      catch { return jsonResponse({ error: "Sign-in is temporarily unavailable. Please try again." }, 503); }
    }

    if (path === "/add.js" && request.method === "GET") return env.ASSETS.fetch(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/favicon.ico" || path === "/favicon.png") {
      return pngResponse(base64ToBytes(FAVICON_PNG_BASE64));
    }

    if (path === "/" || path === "/reading/page" || path === "/reading/html") {
      const items = await getItems(env, parseLimit(url, HISTORY_LIMIT));
      return htmlResponse(renderHtml(items, env));
    }

    if (path === "/reading") {
      return jsonResponse(await getItems(env, parseLimit(url, HISTORY_LIMIT)), 200);
    }

    if (path === "/reading/markdown") {
      const items = await getItems(env, parseLimit(url, README_LIMIT));
      return markdownResponse(renderMarkdown(items));
    }

    if (path === "/reading/rss") {
      const items = await getItems(env, parseLimit(url, HISTORY_LIMIT));
      return rssResponse(renderRss(items, env));
    }

    if (path === "/reading/add" && request.method === "POST") {
      if (!await isAuthorized(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      const payload = await readJson(request);
      if (!payload) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      const itemUrl = normalizeUrl(payload.url);
      if (!itemUrl || itemUrl.length > 4096) {
        return jsonResponse({ error: "Enter a valid HTTP or HTTPS URL (up to 4096 characters)." }, 400);
      }
      const suppliedTitle = normalizeText(payload.title);
      if (payload.title !== undefined && payload.title !== null && typeof payload.title !== "string") {
        return jsonResponse({ error: "Title must be text." }, 400);
      }
      if (suppliedTitle && suppliedTitle.length > 500) return jsonResponse({ error: "Title must be 500 characters or less." }, 400);
      const title = suppliedTitle || await fetchTitle(itemUrl);
      if (!title) return jsonResponse({ error: "Could not fetch the page title. Enter a title and try again." }, 422);

      const addedAt = normalizeIso(payload.added_at) || new Date().toISOString();
      const id = payload.id && typeof payload.id === "string" ? payload.id : itemUrl;

      const item: ReadingItem = {
        id,
        title,
        url: itemUrl,
        added_at: addedAt,
      };

      const items = await readAllItems(env);
      const next = [item, ...items.filter((existing) => existing.url !== item.url)];
      await putItems(env, next.slice(0, MAX_ITEMS));

      return jsonResponse({ ok: true, item }, 201);
    }

    if (path === "/reading/remove" && request.method === "DELETE") {
      if (!await isAuthorized(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      const payload = await readJson(request);
      if (!payload) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      const targetUrl = normalizeUrl(payload.url);
      if (!targetUrl) {
        return jsonResponse({ error: "Missing url" }, 400);
      }

      const items = await readAllItems(env);
      const filtered = items.filter((item) => item.url !== targetUrl);

      if (filtered.length === items.length) {
        return jsonResponse({ error: "Item not found" }, 404);
      }

      await putItems(env, filtered);
      return jsonResponse({ ok: true, removed: targetUrl }, 200);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

function parseLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get("limit");
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

async function readAllItems(env: Env): Promise<ReadingItem[]> {
  const stored = await env.READING_KV.get(KV_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as ReadingItem[];
    return parsed
      .filter((item) => item && item.url && item.title)
      .sort((a, b) => b.added_at.localeCompare(a.added_at));
  } catch {
    return [];
  }
}

async function getItems(env: Env, limit: number): Promise<ReadingItem[]> {
  const items = await readAllItems(env);
  return items.slice(0, limit);
}

async function putItems(env: Env, items: ReadingItem[]): Promise<void> {
  await env.READING_KV.put(KV_KEY, JSON.stringify(items));
}

function renderMarkdown(items: ReadingItem[]): string {
  if (items.length === 0) {
    return "- _No items yet._";
  }

  return items
    .map((item) => {
      const title = truncateTitle(item.title);
      return `- [${escapeMarkdown(title)}](${item.url})`;
    })
    .join("\n");
}

function renderHtml(items: ReadingItem[], env: Env): string {
  const title = env.READING_SITE_TITLE || "Reading Log";
  const siteUrl = env.READING_SITE_URL || env.READING_MORE_URL || "";
  const rssUrl = "/reading/rss";
  const list = items.length
    ? items
        .map((item) => {
          const safeTitle = escapeHtml(item.title);
          const safeUrl = escapeHtml(item.url);
          const host = escapeHtml(getHost(item.url));
          const date = escapeHtml(formatDate(item.added_at));
          return `<li><a href="${safeUrl}" rel="noopener" target="_blank">${safeTitle}</a><span class="meta">${host} · ${date}</span></li>`;
        })
        .join("")
    : '<li class="empty">No items yet.</li>';

  const titleLine = siteUrl
    ? `<a class="title" href="${escapeHtml(siteUrl)}">${escapeHtml(title)}</a>`
    : `<span class="title">${escapeHtml(title)}</span>`;

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    `  <title>${escapeHtml(title)}</title>`,
    "  <link rel=\"icon\" href=\"/favicon.png\" type=\"image/png\" />",
    "  <link rel=\"apple-touch-icon\" href=\"/favicon.png\" />",
    "  <style>",
    "    :root { color-scheme: dark; }",
    "    [hidden] { display: none !important; }",
    "    body { margin: 0; font-family: \"IBM Plex Sans\", \"Space Grotesk\", system-ui, -apple-system, sans-serif; background: #0b0b0b; color: #f5f5f5; }",
    "    main { max-width: 720px; margin: 48px auto; padding: 0 20px; }",
    "    header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 24px; }",
    "    .title { font-size: 24px; font-weight: 600; letter-spacing: 0.02em; color: #f5f5f5; text-decoration: none; }",
    "    .links a { color: #9b9b9b; text-decoration: none; font-size: 14px; }",
    "    .links a:hover { color: #f5f5f5; }",
    "    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }",
    "    li { display: grid; gap: 6px; padding: 12px 0; border-bottom: 1px solid #1c1c1c; }",
    "    li:last-child { border-bottom: none; }",
    "    li a { color: #f5f5f5; text-decoration: none; font-size: 16px; font-weight: 500; line-height: 1.4; }",
    "    li a:hover { text-decoration: underline; }",
    "    .meta { color: #8a8a8a; font-size: 12px; letter-spacing: 0.02em; }",
    "    .empty { color: #8a8a8a; font-size: 14px; }",
    "    .links { display: flex; align-items: center; gap: 16px; }",
    "    button { font: inherit; cursor: pointer; background: #222; color: #f5f5f5; border: 1px solid #555; border-radius: 6px; padding: 8px 12px; }",
    "    button:disabled { opacity: .5; cursor: wait; }",
    "    dialog { color: #f5f5f5; background: #141414; border: 1px solid #555; border-radius: 12px; width: min(440px, calc(100% - 64px)); padding: 24px; }",
    "    dialog::backdrop { background: #000a; }",
    "    dialog h2 { margin-top: 0; }",
    "    dialog label { display: block; margin: 16px 0; font-size: 14px; }",
    "    input { box-sizing: border-box; display: block; width: 100%; margin-top: 8px; padding: 10px; background: #0b0b0b; color: #fff; border: 1px solid #666; border-radius: 6px; font: inherit; }",
    "    #add-status { line-height: 1.5; overflow-wrap: anywhere; }",
    "    #close-add { float: right; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    "    <header>",
    `      ${titleLine}`,
    "      <div class=\"links\">",
    `        <a href=\"${rssUrl}\">RSS</a>`,
    '        <button id="open-add" type="button">Add</button>',
    "      </div>",
    "    </header>",
    `    <ul>${list}</ul>`,
    "  </main>",
    '<dialog id="add-dialog" aria-labelledby="add-heading">',
    '  <button id="close-add" type="button" aria-label="Close">Close</button>',
    '  <h2 id="add-heading">Add an entry</h2>',
    '  <p id="auth-help">Checking sign-in…</p>',
    '  <label hidden>Setup token<input id="setup-token" type="password" autocomplete="off" /></label>',
    '  <button id="unlock" data-action type="button" hidden>Sign in with passkey</button>',
    '  <button id="register" data-action type="button" hidden>Create passkey</button>',
    '  <button id="logout" data-action type="button" hidden>Sign out</button>',
    '  <form id="entry-form" hidden>',
    '    <label>URL<input name="url" type="url" required maxlength="4096" placeholder="https://example.com/article" /></label>',
    '    <label>Title (optional)<input name="title" type="text" maxlength="500" placeholder="Fetched automatically when left blank" /></label>',
    '    <button type="submit" data-action>Add entry</button>',
    '  </form>',
    '  <p id="add-status" role="status" aria-live="polite"></p>',
    '</dialog>',
    '<script src="/add.js" type="module"></script>',
    "</body>",
    "</html>",
  ].join("\n");
}

function renderRss(items: ReadingItem[], env: Env): string {
  const title = env.READING_SITE_TITLE || "Reading Log";
  const siteUrl = env.READING_SITE_URL || env.READING_MORE_URL || "https://reading.aaronmeese.com";
  const updated = items[0]?.added_at || new Date().toISOString();

  const entries = items
    .map((item) => {
      const entryTitle = escapeXml(item.title);
      const entryUrl = escapeXml(item.url);
      const entryDate = escapeXml(item.added_at);
      return [
        "    <item>",
        `      <title>${entryTitle}</title>`,
        `      <link>${entryUrl}</link>`,
        `      <guid>${entryUrl}</guid>`,
        `      <pubDate>${new Date(item.added_at).toUTCString()}</pubDate>`,
        `      <description>${entryTitle}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<rss version=\"2.0\">",
    "  <channel>",
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(siteUrl)}</link>`,
    `    <description>${escapeXml(title)}</description>`,
    `    <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>`,
    entries || "    <item></item>",
    "  </channel>",
    "</rss>",
  ].join("\n");
}

function truncateTitle(title: string): string {
  const normalized = normalizeText(title) || "";
  if (normalized.length >= TRUNCATE_THRESHOLD) {
    return `${normalized.slice(0, TRUNCATE_TO).trimEnd()}…`;
  }
  return normalized;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length ? cleaned : null;
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const token = env.READING_TOKEN;
  const auth = request.headers.get("Authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : request.headers.get("X-Reading-Token");
  if (token && provided && await equalSecret(provided, token)) return true;
  return sameOrigin(request, env) && !!await sessionId(request, env);
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\[\]\\]/g, "\\$&");
}

function escapeHtml(text: string): string {
  return escapeXml(text);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  });
}

function markdownResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "s-maxage=60, max-age=60",
      ...corsHeaders(),
    },
  });
}

function rssResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "s-maxage=60, max-age=60",
      ...corsHeaders(),
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Reading-Token",
  };
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "s-maxage=60, max-age=60",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function pngResponse(body: Uint8Array<ArrayBuffer>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "s-maxage=86400, max-age=86400",
    },
  });
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}
