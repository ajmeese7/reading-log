export interface Env {
  READING_KV: KVNamespace;
  READING_TOKEN: string;
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
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const TRUNCATE_THRESHOLD = 85;
const TRUNCATE_TO = 80;
const FAVICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAtGVYSWZJSSoACAAAAAYAEgEDAAEAAAABAAAAGgEFAAEAAABWAAAAGwEFAAEAAABeAAAAKAEDAAEAAAACAAAAEwIDAAEAAAABAAAAaYcEAAEAAABmAAAAAAAAAEgAAAABAAAASAAAAAEAAAAGAACQBwAEAAAAMDIxMAGRBwAEAAAAAQIDAACgBwAEAAAAMDEwMAGgAwABAAAA//8AAAKgBAABAAAAgAAAAAOgBAABAAAAgAAAAAAAAABKviP0AAACuElEQVR4nO3dMW4aURRA0RnCSOzAhVcQidaNF+AFuLDkcgq3lBFVhJIukheQ6lOzCS/ArZXaiMZQuLY0CZMdvIn1DZnh3tM+gW24+tI8wBSFJEmSJEmSJEmSJEmSJEk6BWVxYqqqaqN50zQn9zfnGGXdWoNnAHAGAGcAcAYAZwBwBgB3itfE4R4g13a7DednZ2eDekw9AeAMAM4A4AwAzgDgDADOAODGBcxkMgnnb29v4Xw+nxenxBMAzgDgDADOAOAMAM4A4AwAbnB7gNFoFL7ev9/vw9vf3t6G85RSkaOu6/D3Syn16v0CngBwBgBnAHAGAGcAcAYAZwBwg9sDdF3nLxaLcL5er7N+furYE9R1XQyJJwCcAcAZAJwBwBkAnAHAGQBcr16bPtLn/8tD3n/dsQe4vLwM53d3d0d9TjwB4AwAzgDgDADOAOAMAM4A4Hq3B6iq6nc0n81mn6L5/f191s8vy/ghadu8NcTFxUU4f3x8dA+g4zEAOAOAMwA4A4AzADgDgOvd5wKapgmv819fX8Pbn5+ff43mV1dX33Le918eeE9wbJ4AcAYAZwBwBgBnAHAGAGcAcP9jD3DQC+XdbvczmqeUvufcf5t5oT+dTnPfD/Chj58nAJwBwBkAnAHAGQCcAcAZANx4aNf5T09P4bxpml3RY2XH+wmOzRMAzgDgDADOAOAMAM4A4AwA7hB7gDLze/WyXk/fbDZfovnLy8uPIk/ZMW+H9LkBTwA4A4AzADgDgDMAOAOAMwC4fr04/Q+69gjL5TLcbbRt+yfzV2gP+f8Dur5vIKX0oc+ZJwCcAcAZAJwBwBkAnAHAGQDc4PYAQ99TPDw8hLd/fn4O5zc3N+F8tVq96zn1BIAzADgDgDMAOAOAMwA4A4BzD9Az19fXv6L5eDz+HM3dA+hdDADOAOD+AmdVf9wMHp+YAAAAAElFTkSuQmCC";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/favicon.ico" || path === "/favicon.png") {
      return pngResponse(base64ToBytes(FAVICON_PNG_BASE64));
    }

    if (path === "/" || path === "/reading/page" || path === "/reading/html") {
      const items = await getItems(env, parseLimit(url));
      return htmlResponse(renderHtml(items, env));
    }

    if (path === "/reading") {
      return jsonResponse(await getItems(env, parseLimit(url)), 200);
    }

    if (path === "/reading/markdown") {
      const items = await getItems(env, parseLimit(url));
      return markdownResponse(renderMarkdown(items));
    }

    if (path === "/reading/rss") {
      const items = await getItems(env, parseLimit(url));
      return rssResponse(renderRss(items, env));
    }

    if (path === "/reading/add" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      const payload = await readJson(request);
      if (!payload) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      const title = normalizeText(payload.title);
      const itemUrl = normalizeUrl(payload.url);
      if (!title || !itemUrl) {
        return jsonResponse({ error: "Missing title or url" }, 400);
      }

      const addedAt = normalizeIso(payload.added_at) || new Date().toISOString();
      const id = payload.id && typeof payload.id === "string" ? payload.id : itemUrl;

      const item: ReadingItem = {
        id,
        title,
        url: itemUrl,
        added_at: addedAt,
      };

      const items = await getItems(env);
      const next = [item, ...items.filter((existing) => existing.url !== item.url)];
      await putItems(env, next.slice(0, MAX_ITEMS));

      return jsonResponse({ ok: true, item }, 201);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  const parsed = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

async function getItems(env: Env, limit: number = DEFAULT_LIMIT): Promise<ReadingItem[]> {
  const stored = await env.READING_KV.get(KV_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as ReadingItem[];
    return parsed
      .filter((item) => item && item.url && item.title)
      .sort((a, b) => b.added_at.localeCompare(a.added_at))
      .slice(0, limit);
  } catch {
    return [];
  }
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
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    "    <header>",
    `      ${titleLine}`,
    "      <div class=\"links\">",
    `        <a href=\"${rssUrl}\">RSS</a>`,
    "      </div>",
    "    </header>",
    `    <ul>${list}</ul>`,
    "  </main>",
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

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = env.READING_TOKEN;
  if (!token) {
    return false;
  }
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim() === token;
  }
  const alt = request.headers.get("X-Reading-Token");
  return alt === token;
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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Reading-Token",
  };
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "s-maxage=60, max-age=60",
    },
  });
}

function pngResponse(body: Uint8Array): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "s-maxage=86400, max-age=86400",
    },
  });
}

function base64ToBytes(base64: string): Uint8Array {
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
