// lib/readJson.js
// An API can answer with something that isn't JSON at all - Vercel's own HTML
// page when a function times out, for instance. Blowing up on that hides the
// real problem behind "Unexpected token 'A'", so turn it into a readable line.
export async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    const detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (res.status === 504 || /timed out|timeout/i.test(detail)) {
      return {
        ok: false,
        message: 'The check took too long and the server cut it off.',
        detail: 'Usually the provider is busy right now — try again in a minute.',
      };
    }
    return { ok: false, message: `Server answered ${res.status} without JSON.`, detail };
  }
}
