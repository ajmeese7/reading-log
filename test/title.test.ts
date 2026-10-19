import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Use the real Workers HTMLRewriter with deterministic outbound HTTP fixtures.
test("automatic titles in the Workers runtime", async t => {
  const bundle = await build({ stdin: {
    contents: `import { fetchTitle } from "./src/title.ts";
      export default { async fetch(request) {
        return Response.json({ title: await fetchTitle(new URL(request.url).searchParams.get("url")) });
      } };`, resolveDir: process.cwd(),
  }, bundle: true, format: "esm", write: false });
  const fetched: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-19",
    outboundService: async request => {
      fetched.push(request.url);
      const path = new URL(request.url).pathname;
      if (path === "/redirect") return new Response(null, { status: 302, headers: { Location: "/article" } });
      if (path === "/private") return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret" } });
      if (path === "/loop") return new Response(null, { status: 302, headers: { Location: "/loop" } });
      if (path === "/blocked") return new Response("Forbidden", { status: 403 });
      if (path === "/json") return Response.json({ title: "Not HTML" });
      const html = path === "/large" ? "x".repeat(512 * 1024 + 1) : path === "/empty" ? "<html></html>"
        : "<!doctype html><!-- <title>Wrong</title> --><html><head><title>  Reading &amp; writing &#8212; together  </title></head></html>";
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  }));
  t.after(() => runtime.dispose());
  async function title(path: string) {
    const response = await runtime.dispatchFetch("https://worker.test/?url=" + encodeURIComponent("https://example.com" + path));
    return (await response.json() as { title: string | null }).title;
  }
  await t.test("extracts and decodes the title without treating comments as markup", async () => {
    assert.equal(await title("/article"), "Reading & writing — together");
  });
  await t.test("follows public redirects", async () => {
    assert.equal(await title("/redirect"), "Reading & writing — together");
  });
  await t.test("refuses redirects into private destinations", async () => {
    assert.equal(await title("/private"), null);
    assert.ok(!fetched.some(url => url.includes("127.0.0.1")));
  });
  await t.test("bounds redirects, page size, and accepted content", async () => {
    for (const path of ["/loop", "/large", "/empty", "/json", "/blocked"]) assert.equal(await title(path), null, path);
  });
});
