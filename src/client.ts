import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

const dialog = document.querySelector<HTMLDialogElement>("#add-dialog")!;
const status = document.querySelector<HTMLElement>("#add-status")!;
const form = document.querySelector<HTMLFormElement>("#entry-form")!;
const login = document.querySelector<HTMLButtonElement>("#unlock")!;
const register = document.querySelector<HTMLButtonElement>("#register")!;
const logout = document.querySelector<HTMLButtonElement>("#logout")!;
const setup = document.querySelector<HTMLInputElement>("#setup-token")!;
let authenticated = false;
let busy = false;
let editingUrl: string | null = null;
const heading = document.querySelector<HTMLElement>("#add-heading")!;
const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;

async function api<T = { ok: boolean }>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Request failed. Please try again.");
  return result;
}

async function refresh() {
  const state = await api<{ authenticated: boolean; registered: boolean }>("/auth/me");
  authenticated = state.authenticated;
  form.hidden = !authenticated;
  document.querySelectorAll<HTMLButtonElement>(".edit-entry").forEach(button => button.hidden = !authenticated);
  login.hidden = authenticated || !state.registered;
  register.hidden = !authenticated && state.registered;
  register.textContent = authenticated ? "Add another passkey" : "Create passkey";
  logout.hidden = !authenticated;
  setup.closest<HTMLElement>("label")!.hidden = authenticated || state.registered;
  document.querySelector<HTMLElement>("#auth-help")!.textContent = authenticated
    ? "Signed in. You can add a passkey for another device here."
    : state.registered ? "Sign in with your passkey to add an entry. You can also use a passkey on your phone."
    : "Enter your setup token to register the first passkey.";
}

async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  status.textContent = "";
  dialog.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach(b => b.disabled = true);
  try { await action(); }
  catch (error) {
    status.textContent = error instanceof Error && error.name === "NotAllowedError"
      ? "Passkey request cancelled or timed out. Please try again."
      : error instanceof Error ? error.message : "Something went wrong. Please try again.";
  } finally {
    busy = false;
    dialog.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach(b => b.disabled = false);
  }
}

document.querySelector("#open-add")!.addEventListener("click", () => {
  editingUrl = null;
  form.reset();
  heading.textContent = "Add an entry";
  submit.textContent = "Add entry";
  dialog.showModal();
  void run(refresh);
});
document.querySelectorAll<HTMLButtonElement>(".edit-entry").forEach(button => {
  button.addEventListener("click", () => {
    if (busy || !authenticated) return;
    editingUrl = button.dataset.url!;
    (form.elements.namedItem("url") as HTMLInputElement).value = editingUrl;
    (form.elements.namedItem("title") as HTMLInputElement).value = button.dataset.title!;
    heading.textContent = "Edit entry";
    submit.textContent = "Save changes";
    dialog.showModal();
    void run(refresh);
  });
});
// Check the session on page load so returning users see their edit controls.
void refresh().catch(() => {});
document.querySelector("#close-add")!.addEventListener("click", () => dialog.close());
login.addEventListener("click", () => void run(async () => {
  if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys.");
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/auth/login/options", {});
  const credential = await startAuthentication({ optionsJSON });
  await api("/auth/login/verify", credential);
  await refresh();
}));
register.addEventListener("click", () => void run(async () => {
  if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys.");
  const setupToken = setup.value;
  setup.value = "";
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/register/options", { setupToken });
  const credential = await startRegistration({ optionsJSON });
  await api("/auth/register/verify", credential);
  await refresh();
  status.textContent = "Passkey added.";
}));
logout.addEventListener("click", () => void run(async () => {
  await api("/auth/logout", {});
  await refresh();
}));
form.addEventListener("submit", event => {
  event.preventDefault();
  void run(async () => {
    const values = new FormData(form);
    try {
      await api(editingUrl ? "/reading/edit" : "/reading/add", {
        url: values.get("url"), title: values.get("title"), original_url: editingUrl,
      });
    } catch (error) {
      await refresh();
      throw error;
    }
    // Reload the public list with a cache-busting query so the new entry is visible.
    const url = new URL(location.href);
    url.searchParams.set("updated", Date.now().toString());
    location.assign(url.href);
  });
});
