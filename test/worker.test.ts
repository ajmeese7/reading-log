import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const TOKEN = "test-token";

/**
 * In-memory KV backed by a Map. This is a real implementation of the get/put
 * contract the worker uses, not a behaviour-inventing mock: values round-trip
 * as strings exactly as Workers KV does.
 */
function createEnv() {
  const store = new Map<string, string>();
  return {
    store,
    env: {
      READING_KV: {
        get: async (key: string) => (store.has(key) ? store.get(key)! : null),
        put: async (key: string, value: string) => void store.set(key, value),
      },
      READING_TOKEN: TOKEN,
    },
  };
}

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

function addItem(env: any, title: string, url: string, addedAt: string) {
  return worker.fetch(
    new Request("https://reading.test/reading/add", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title, url, added_at: addedAt }),
    }),
    env,
  );
}

function removeItem(env: any, url: string) {
  return worker.fetch(
    new Request("https://reading.test/reading/remove", {
      method: "DELETE",
      headers: authHeaders,
      body: JSON.stringify({ url }),
    }),
    env,
  );
}

const getPath = (env: any, path: string) =>
  worker.fetch(new Request(`https://reading.test${path}`), env);

/** Adds `count` items, oldest first, one request each. */
async function seed(env: any, count: number, dayOfMonth = 1) {
  for (let i = 0; i < count; i += 1) {
    const addedAt = new Date(Date.UTC(2026, 0, dayOfMonth, 0, i)).toISOString();
    const response = await addItem(env, `Article ${i}`, `https://example.com/${i}`, addedAt);
    assert.equal(response.status, 201, `seeding item ${i} failed`);
  }
}

const storedItems = (store: Map<string, string>) =>
  JSON.parse(store.get("reading-items") ?? "[]");

describe("POST /reading/add", () => {
  let ctx: ReturnType<typeof createEnv>;
  beforeEach(() => { ctx = createEnv(); });

  test("retains every previously added item instead of truncating to the read limit", async () => {
    // Arrange + act: 30 sequential adds, each a separate read-modify-write.
    await seed(ctx.env, 30);

    // Assert: regression guard. Adds previously read only the 5 newest items
    // before rewriting KV, which capped stored history at 6 entries.
    assert.equal(storedItems(ctx.store).length, 30);
  });

  test("stores items newest first", async () => {
    await seed(ctx.env, 10);

    assert.equal(storedItems(ctx.store)[0].title, "Article 9");
  });

  test("caps stored history at 100 items, dropping the oldest", async () => {
    await seed(ctx.env, 105);

    const stored = storedItems(ctx.store);
    assert.equal(stored.length, 100);
    assert.equal(stored[0].title, "Article 104");
    assert.equal(stored.at(-1).title, "Article 5");
  });

  test("replaces an existing entry with the same url rather than duplicating it", async () => {
    await addItem(ctx.env, "First title", "https://example.com/a", "2026-01-01T00:00:00.000Z");
    await addItem(ctx.env, "Updated title", "https://example.com/a", "2026-01-02T00:00:00.000Z");

    const stored = storedItems(ctx.store);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, "Updated title");
  });

  test("rejects an unauthenticated request", async () => {
    const response = await worker.fetch(
      new Request("https://reading.test/reading/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "T", url: "https://example.com/x" }),
      }),
      ctx.env,
    );

    assert.equal(response.status, 401);
    assert.equal(storedItems(ctx.store).length, 0);
  });
});

describe("DELETE /reading/remove", () => {
  test("removes only the targeted item and leaves the rest of the history intact", async () => {
    const ctx = createEnv();
    await seed(ctx.env, 30);

    const response = await removeItem(ctx.env, "https://example.com/10");

    assert.equal(response.status, 200);
    const stored = storedItems(ctx.store);
    assert.equal(stored.length, 29);
    assert.ok(!stored.some((item: any) => item.url === "https://example.com/10"));
  });

  test("returns 404 when no item matches the url", async () => {
    const ctx = createEnv();
    await seed(ctx.env, 3);

    const response = await removeItem(ctx.env, "https://example.com/absent");

    assert.equal(response.status, 404);
    assert.equal(storedItems(ctx.store).length, 3);
  });
});

describe("read endpoint limits", () => {
  let ctx: ReturnType<typeof createEnv>;
  beforeEach(async () => { ctx = createEnv(); await seed(ctx.env, 30); });

  test("GET /reading returns the full history by default", async () => {
    const body = await (await getPath(ctx.env, "/reading")).json();

    assert.equal((body as unknown[]).length, 30);
  });

  test("GET /reading/rss returns the full history by default", async () => {
    const body = await (await getPath(ctx.env, "/reading/rss")).text();

    assert.equal((body.match(/<item>/g) ?? []).length, 30);
  });

  test("GET / returns the full history by default", async () => {
    const body = await (await getPath(ctx.env, "/")).text();

    assert.equal((body.match(/<li>/g) ?? []).length, 30);
  });

  test("GET /reading/markdown returns 5 items by default for the profile README", async () => {
    const body = await (await getPath(ctx.env, "/reading/markdown")).text();

    assert.equal(body.trim().split("\n").length, 5);
  });

  test("honours an explicit limit below the default", async () => {
    const body = await (await getPath(ctx.env, "/reading?limit=5")).json();

    assert.equal((body as unknown[]).length, 5);
  });

  test("no longer clamps an explicit limit to 20", async () => {
    const body = await (await getPath(ctx.env, "/reading?limit=100")).json();

    assert.equal((body as unknown[]).length, 30);
  });

  test("falls back to the endpoint default when limit is not a number", async () => {
    const body = await (await getPath(ctx.env, "/reading/markdown?limit=abc")).text();

    assert.equal(body.trim().split("\n").length, 5);
  });
});
