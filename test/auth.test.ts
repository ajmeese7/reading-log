import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, createHash, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import worker from "../src/index.ts";
import { encode } from "../src/auth.ts";
import { publicUrl, fetchTitle } from "../src/title.ts";

const origin = "https://reading.test";
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

// Execute the actual migration and route SQL against SQLite rather than inventing
// database responses. The small adapter supplies only the D1 methods in use.
function context() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0001_auth.sql", import.meta.url), "utf8"));
  function prepare(sql: string) {
    let args: any[] = [];
    return {
      bind(...values: any[]) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
    };
  }
  const store = new Map<string, string>();
  const env: any = {
    AUTH_DB: { prepare, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())); } },
    AUTH_ORIGIN: origin,
    SETUP_TOKEN: "test-only-setup-token",
    READING_TOKEN: "test-only-api-token",
    READING_KV: { get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); } },
  };
  const request = (path: string, body?: unknown, cookie?: string, from: string | null = origin) => worker.fetch(
    new Request(origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { ...(from ? { Origin: from } : {}), ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { db, env, store, request };
}

function passkey(challenge: string, clientOrigin = origin, flags = 0x45) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const cose = isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
    [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
  ]));
  const rpHash = createHash("sha256").update("reading.test").digest();
  const data = Buffer.concat([rpHash, Buffer.from([flags, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
  const clientDataJSON = encode(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: clientOrigin })));
  const response = { id: encode(id), rawId: encode(id), type: "public-key", response: {
    clientDataJSON,
    attestationObject: encode(isoCBOR.encode(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(data)]]))),
    transports: ["internal"],
  }, clientExtensionResults: {} };
  return {
    response,
    assertion(challenge: string, clientOrigin = origin, flags = 0x05) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: clientOrigin }));
      const data = Buffer.concat([rpHash, Buffer.from([flags, 0, 0, 0, 1])]);
      return { id: encode(id), rawId: encode(id), type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: encode(clientData), authenticatorData: encode(data),
        signature: encode(sign("sha256", Buffer.concat([data, createHash("sha256").update(clientData).digest()]), privateKey)),
        userHandle: "AQ",
      } };
    },
  };
}

async function register(ctx: ReturnType<typeof context>) {
  const options = await (await ctx.request("/auth/register/options", { setupToken: ctx.env.SETUP_TOKEN })).json();
  const key = passkey(options.challenge);
  const response = await ctx.request("/auth/register/verify", key.response);
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
  return { key, cookie, response };
}

describe("passkey authentication", () => {
  test("requires the setup secret and a same-origin request for first registration", async () => {
    const ctx = context();
    assert.equal((await ctx.request("/auth/register/options", {})).status, 401);
    assert.equal((await ctx.request("/auth/register/options", { setupToken: "wrong" })).status, 401);
    assert.equal((await ctx.request("/auth/register/options", { setupToken: ctx.env.SETUP_TOKEN }, undefined, "https://evil.test")).status, 403);
    assert.equal((await ctx.request("/auth/login/options", {}, undefined, null)).status, 403);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM challenges").get()!.count, 0);
  });

  test("verifies a real registration, sets a secure cookie, and accepts an authenticated add", async () => {
    const ctx = context();
    const { cookie, response } = await register(ctx);
    assert.match(response.headers.get("Set-Cookie")!, /HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
    assert.deepEqual(await (await ctx.request("/auth/me", undefined, cookie)).json(), { authenticated: true, registered: true });
    assert.equal((await ctx.request("/reading/add", { url: "https://example.com/article", title: "A title" }, cookie)).status, 201);
    assert.equal(JSON.parse(ctx.store.get("reading-items")!)[0].title, "A title");
    assert.ok(!ctx.db.prepare("SELECT id FROM sessions").get()!.id.includes(cookie.split("=")[1]));
  });

  test("rejects cross-origin cookie writes and expired or forged sessions", async () => {
    const ctx = context();
    const { cookie } = await register(ctx);
    const body = { url: "https://example.com", title: "Title" };
    assert.equal((await ctx.request("/reading/add", body, cookie, "https://evil.test")).status, 401);
    assert.equal((await ctx.request("/reading/add", body, cookie, null)).status, 401);
    assert.equal((await ctx.request("/reading/add", body, "reading_session=" + "a".repeat(43))).status, 401);
    ctx.db.exec("UPDATE sessions SET expires = 0");
    assert.equal((await ctx.request("/reading/add", body, cookie)).status, 401);
    assert.equal(ctx.store.size, 0);
  });

  test("disables setup registration after the first passkey, but allows a signed-in device", async () => {
    const ctx = context();
    const { cookie } = await register(ctx);
    assert.equal((await ctx.request("/auth/register/options", { setupToken: ctx.env.SETUP_TOKEN })).status, 401);
    const options = await (await ctx.request("/auth/register/options", {}, cookie)).json();
    const key = passkey(options.challenge);
    assert.equal((await ctx.request("/auth/register/verify", key.response)).status, 401);
    // Failed use consumed that challenge; the signed-in browser requests another.
    const next = await (await ctx.request("/auth/register/options", {}, cookie)).json();
    assert.equal((await ctx.request("/auth/register/verify", passkey(next.challenge).response, cookie)).status, 200);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM credentials").get()!.count, 2);
  });

  test("rejects stale bootstrap challenges and registration replays", async () => {
    const ctx = context();
    const stale = await (await ctx.request("/auth/register/options", { setupToken: ctx.env.SETUP_TOKEN })).json();
    const { key } = await register(ctx);
    assert.equal((await ctx.request("/auth/register/verify", key.response)).status, 400);
    assert.equal((await ctx.request("/auth/register/verify", passkey(stale.challenge).response)).status, 401);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM credentials").get()!.count, 1);
  });

  test("signs in with a real signature, rejects replay, and logs out server-side", async () => {
    const ctx = context();
    const { key } = await register(ctx);
    const options = await (await ctx.request("/auth/login/options", {})).json();
    const assertion = key.assertion(options.challenge);
    const response = await ctx.request("/auth/login/verify", assertion);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await ctx.request("/auth/login/verify", assertion)).status, 400);
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    assert.equal((await ctx.request("/auth/logout", {}, cookie)).status, 200);
    assert.equal((await (await ctx.request("/auth/me", undefined, cookie)).json()).authenticated, false);
  });

  test("rejects an expired challenge, an incorrect origin, a bad signature, and missing user verification", async () => {
    const ctx = context();
    const { key } = await register(ctx);
    for (const reason of ["expired", "origin", "signature", "verification"]) {
      const options = await (await ctx.request("/auth/login/options", {})).json();
      const assertion = key.assertion(options.challenge, reason === "origin" ? "https://evil.test" : origin, reason === "verification" ? 1 : 5);
      if (reason === "expired") ctx.db.exec("UPDATE challenges SET expires = 0");
      if (reason === "signature") assertion.response.signature = encode(randomBytes(64));
      assert.equal((await ctx.request("/auth/login/verify", assertion)).status, 400, reason);
    }
  });

  test("rejects malformed JSON values and rate-limits sign-in attempts", async () => {
    const ctx = context();
    for (const body of [null, [], "text"]) assert.equal((await ctx.request("/auth/login/options", body)).status, 400);
    ctx.env.AUTH_LIMITER = { limit: async () => ({ success: false }) };
    assert.equal((await ctx.request("/auth/login/options", {})).status, 429);
  });
});

describe("web entry validation", () => {
  test("keeps the reading page and feeds public and exposes the Add control", async () => {
    const ctx = context();
    for (const path of ["/", "/reading", "/reading/markdown", "/reading/rss"]) assert.equal((await ctx.request(path)).status, 200);
    const html = await (await ctx.request("/")).text();
    assert.match(html, /id="open-add"/);
    assert.match(html, /name="title" type="text"/);
    assert.ok(!html.includes(ctx.env.SETUP_TOKEN));
    assert.ok(!html.includes(ctx.env.READING_TOKEN));
  });

  test("rejects unsafe URL schemes and malformed payloads even with API auth", async () => {
    const ctx = context();
    const add = (body: unknown) => worker.fetch(new Request(origin + "/reading/add", {
      method: "POST", headers: { Authorization: `Bearer ${ctx.env.READING_TOKEN}` }, body: JSON.stringify(body),
    }), ctx.env);
    for (const url of ["javascript:alert(1)", "data:text/html,test", "ftp://example.com", "https://user:password@example.com"]) {
      assert.equal((await add({ url, title: "A title" })).status, 400);
    }
    for (const body of [null, [], { url: "https://example.com", title: 12 }, { url: "https://example.com", title: "x".repeat(501) }]) {
      assert.equal((await add(body)).status, 400);
    }
    // Private links may be saved with an explicit title, but are never fetched.
    assert.equal((await add({ url: "http://127.0.0.1/private" })).status, 422);
    assert.equal((await add({ url: "http://127.0.0.1/private", title: "Manual title" })).status, 201);
  });

  test("rejects private and non-HTTP title lookup destinations", async () => {
    for (const url of ["file:///etc/passwd", "http://127.0.0.1", "http://2130706433", "http://[::1]", "http://localhost", "https://foo.local", "https://metadata.google.internal", "https://example.com:8080"]) {
      assert.equal(publicUrl(url), null, url);
      assert.equal(await fetchTitle(url), null);
    }
    assert.ok(publicUrl("https://www.example.com/article"));
  });
});
