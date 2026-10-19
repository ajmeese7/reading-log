/** Bound JSON input before buffering it; Content-Length alone cannot be trusted. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "", length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 32_768) return null;
      text += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
  finally { await reader.cancel(); }
}
