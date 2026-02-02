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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/" || path === "/reading") {
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

function renderRss(items: ReadingItem[], env: Env): string {
  const title = env.READING_SITE_TITLE || "Reading Log";
  const siteUrl = env.READING_SITE_URL || env.READING_MORE_URL || "https://read.aaronmeese.com";
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
