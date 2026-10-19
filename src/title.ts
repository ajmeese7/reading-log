import { decodeHTML } from "entities";

/** Reject local hostnames and IP literals, including each redirect target. */
export function publicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) || !host.includes(".") ||
      /^[\d.]+$/.test(host) || host.includes(":") ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)) return null;
    return url;
  } catch { return null; }
}

export async function fetchTitle(value: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let url = publicUrl(value);
    for (let redirects = 0; url && redirects <= 3; redirects++) {
      const response = await fetch(url, { redirect: "manual", signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        url = location ? publicUrl(new URL(location, url).href) : null;
        continue;
      }
      if (!response.ok || !response.body ||
        !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
        await response.body?.cancel();
        return null;
      }
      // Bound decompressed bytes, even if Content-Length is missing or misleading.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          length += chunk.length;
          if (length > 512 * 1024) return null;
          chunks.push(chunk);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let title = "";
      let found = false, active = false;
      const parsed = new HTMLRewriter().on("title", {
        element(element) {
          active = !found;
          found = true;
          element.onEndTag(() => { active = false; });
        },
        text(chunk) { if (active) title += chunk.text; },
      }).transform(new Response(bytes, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
      await parsed.arrayBuffer();
      return decodeHTML(title).replace(/\s+/g, " ").trim().slice(0, 500) || null;
    }
  } catch { /* A manual title lets the owner add unavailable or protected pages. */ }
  finally { clearTimeout(timeout); }
  return null;
}
