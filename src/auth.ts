import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type { Env } from "./index.ts";
import { readJson } from "./body.ts";

const SESSION_SECONDS = 60 * 60 * 24 * 30;
const COOKIE = "reading_session";
const now = () => Math.floor(Date.now() / 1000);

export function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

export async function equalSecret(a: string, b: string): Promise<boolean> {
  const hash = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [aHash, bHash] = await Promise.all([hash(a), hash(b)]);
  const aa = new Uint8Array(aHash), bb = new Uint8Array(bHash);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

export function sameOrigin(request: Request, env: Env): boolean {
  // Use a fixed trusted origin rather than deriving trust from request headers.
  return request.headers.get("Origin") === env.AUTH_ORIGIN;
}

function sessionToken(request: Request): string | null {
  return request.headers.get("Cookie")?.match(/(?:^|;\s*)reading_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1] ?? null;
}

async function tokenHash(token: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

export async function sessionId(request: Request, env: Env): Promise<string | null> {
  const token = sessionToken(request);
  if (!token || !env.AUTH_DB) return null;
  const id = await tokenHash(token);
  const session = await env.AUTH_DB.prepare("SELECT id FROM sessions WHERE id = ? AND expires > ?")
    .bind(id, now()).first();
  return session ? id : null;
}

function cookie(env: Env, token: string, age: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${env.AUTH_ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function startSession(env: Env, credentialId: string): Promise<Response> {
  const token = encode(crypto.getRandomValues(new Uint8Array(32)));
  await env.AUTH_DB.prepare("INSERT INTO sessions (id, credential_id, expires) VALUES (?, ?, ?)")
    .bind(await tokenHash(token), credentialId, now() + SESSION_SECONDS).run();
  return json({ ok: true }, 200, { "Set-Cookie": cookie(env, token, SESSION_SECONDS) });
}

async function credentials(env: Env) {
  return (await env.AUTH_DB.prepare("SELECT id FROM credentials").all<{ id: string }>()).results;
}

export async function authRoute(request: Request, env: Env, path: string): Promise<Response> {
  if (!env.AUTH_DB || !env.AUTH_ORIGIN) return json({ error: "Passkey sign-in is not configured yet." }, 503);
  if (request.method === "GET" && path === "/auth/me") {
    return json({ authenticated: !!await sessionId(request, env), registered: (await credentials(env)).length > 0 });
  }
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  if (!sameOrigin(request, env)) return json({ error: "Invalid origin" }, 403);
  // Expired rows are also checked on every lookup; this bounds retained state.
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare("DELETE FROM challenges WHERE expires <= ?").bind(now()),
    env.AUTH_DB.prepare("DELETE FROM sessions WHERE expires <= ?").bind(now()),
  ]);
  if (path === "/auth/logout") {
    const id = await sessionId(request, env);
    if (id) await env.AUTH_DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie(env, "", 0) });
  }
  const body = await readJson(request);
  if (!body) return json({ error: "Invalid JSON body (maximum 32 KB)." }, 400);
  const rpID = new URL(env.AUTH_ORIGIN).hostname;
  const register = path.startsWith("/auth/register/");
  const kind = register ? "register" : "login";
  if (path === `/auth/${kind}/options`) {
    const existing = await credentials(env);
    const session = await sessionId(request, env);
    if (register && !session && !(existing.length === 0 && env.SETUP_TOKEN &&
      typeof body.setupToken === "string" && await equalSecret(body.setupToken, env.SETUP_TOKEN))) {
      return json({ error: "Registration requires the setup token or an existing session." }, 401);
    }
    const options = register
      ? await generateRegistrationOptions({
        rpName: "Reading Log", rpID, userID: new Uint8Array([1]), userName: "owner",
        attestationType: "none", excludeCredentials: existing,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      })
      : await generateAuthenticationOptions({ rpID, userVerification: "required" });
    await env.AUTH_DB.prepare("INSERT INTO challenges (id, kind, grant_session, expires) VALUES (?, ?, ?, ?)")
      .bind(options.challenge, kind, register ? session : null, now() + 300).run();
    return json(options);
  }
  if (path !== `/auth/${kind}/verify`) return json({ error: "Not found" }, 404);
  let challenge: string;
  try {
    const response = body.response as { clientDataJSON: string };
    challenge = JSON.parse(new TextDecoder().decode(decode(response.clientDataJSON))).challenge;
    if (typeof challenge !== "string") throw new Error();
  } catch { return json({ error: "Invalid passkey response" }, 400); }
  // DELETE RETURNING is atomic: even concurrent replays cannot use a challenge twice.
  const grant = await env.AUTH_DB.prepare("DELETE FROM challenges WHERE id = ? AND kind = ? AND expires > ? RETURNING grant_session")
    .bind(challenge, kind, now()).first<{ grant_session: string | null }>();
  if (!grant) return json({ error: "Challenge expired or already used. Please try again." }, 400);
  if (register) {
    const session = await sessionId(request, env);
    if (grant.grant_session ? session !== grant.grant_session : (await credentials(env)).length > 0) {
      return json({ error: "Registration is no longer authorized." }, 401);
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response: body as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge, expectedOrigin: env.AUTH_ORIGIN, expectedRPID: rpID, requireUserVerification: true });
    } catch { return json({ error: "Passkey verification failed." }, 400); }
    if (!verification.verified || !verification.registrationInfo) return json({ error: "Passkey verification failed." }, 400);
    const c = verification.registrationInfo.credential;
    // The conditional insert also closes the race between two first-registration ceremonies.
    const result = await env.AUTH_DB.prepare(`INSERT INTO credentials (id, public_key, counter, transports)
      SELECT ?, ?, ?, ? WHERE ? = 1 OR NOT EXISTS (SELECT 1 FROM credentials)`)
      .bind(c.id, encode(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), grant.grant_session ? 1 : 0).run();
    if (!result.meta.changes) return json({ error: "A passkey already exists. Sign in to add another." }, 409);
    return startSession(env, c.id);
  }
  if (typeof body.id !== "string") return json({ error: "Invalid passkey response" }, 400);
  const row = await env.AUTH_DB.prepare("SELECT * FROM credentials WHERE id = ?").bind(body.id)
    .first<{ id: string; public_key: string; counter: number; transports: string }>();
  if (!row) return json({ error: "Passkey verification failed." }, 400);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({ response: body as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge, expectedOrigin: env.AUTH_ORIGIN, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: row.id, publicKey: decode(row.public_key), counter: row.counter,
        transports: JSON.parse(row.transports) as AuthenticatorTransportFuture[] } });
  } catch { return json({ error: "Passkey verification failed." }, 400); }
  if (!verification.verified) return json({ error: "Passkey verification failed." }, 400);
  await env.AUTH_DB.prepare("UPDATE credentials SET counter = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, row.id).run();
  return startSession(env, row.id);
}
