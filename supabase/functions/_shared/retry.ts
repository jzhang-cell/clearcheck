// fetchWithRetry — shared "try again" wrapper for transient network failures
// against external services (Google Drive, Airtable).
//
// Retries on: thrown network errors (connection reset, DNS, stalled fetch) and
// retryable HTTP statuses (408/429/5xx). Anything else — 2xx, 404, 422 — returns
// immediately: those are real answers, not blips, and retrying them only burns
// time and rate-limit budget. A 429's Retry-After header is honored (capped at
// maxDelayMs so a background task never stalls on a long server-suggested wait);
// otherwise backoff is exponential with jitter.
//
// Callers whose POST CREATES a record should pass retryStatuses: [429] — a 5xx
// is ambiguous (the server may have already applied the write) and retrying it
// could duplicate the record. 429 is always safe: the request was rejected.
//
// An AbortError from a caller-supplied signal is rethrown immediately — that's
// the caller saying "stop", not a blip.

const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504];

export interface FetchRetryOptions {
  attempts?: number; // total attempts, default 3
  baseDelayMs?: number; // first backoff, default 500 (doubles per attempt)
  maxDelayMs?: number; // ceiling for any single wait, default 10s
  label?: string; // for log lines, default hostname
  retryStatuses?: number[]; // default 408/429/5xx
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  opts?: FetchRetryOptions,
): Promise<Response> {
  const attempts = Math.max(1, opts?.attempts ?? 3);
  const baseDelayMs = Math.max(0, opts?.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, opts?.maxDelayMs ?? 10_000);
  const retryStatuses = new Set(opts?.retryStatuses ?? DEFAULT_RETRY_STATUSES);
  const label = opts?.label ?? new URL(input).hostname;

  const backoff = (attempt: number) =>
    Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.25));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(input, init);
      if (!retryStatuses.has(res.status) || attempt === attempts) return res;
      // Drain the body so the connection can be reused, then wait and retry.
      await res.body?.cancel();
      const retryAfterS = Number(res.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfterS) && retryAfterS > 0
        ? Math.min(maxDelayMs, retryAfterS * 1000)
        : backoff(attempt);
      console.warn(
        `fetchWithRetry(${label}) attempt ${attempt}/${attempts}: HTTP ${res.status}, ` +
          `retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      lastErr = err;
      if (attempt === attempts) throw err;
      const delay = backoff(attempt);
      console.warn(
        `fetchWithRetry(${label}) attempt ${attempt}/${attempts} threw: ` +
          `${(err as Error).message} — retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable: the loop always returns or throws on the last attempt
}
