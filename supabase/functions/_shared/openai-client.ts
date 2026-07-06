const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_ENDPOINT = "https://api.openai.com/v1/embeddings";

// Per-attempt timeout. fetch has no default timeout, so a stalled embeddings call
// would hang the file's worker forever (one cause of frozen control progress bars).
const EMBEDDING_TIMEOUT_MS = Math.max(
  5_000,
  Number(Deno.env.get("EMBEDDING_TIMEOUT_MS") ?? "20000"),
);

export async function generateEmbedding(
  text: string,
): Promise<{ embedding: number[]; tokens: number }> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  // Two attempts with a real AbortController timeout — a transient stall aborts and
  // retries once instead of hanging until the platform kills the whole invocation.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EMBEDDING_TIMEOUT_MS);
    try {
      const resp = await fetch(EMBEDDING_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(
          `OpenAI embeddings failed (${resp.status}): ${errText.slice(0, 500)}`,
        );
      }

      const data = await resp.json() as {
        data: { embedding: number[] }[];
        usage: { total_tokens: number };
      };

      return {
        embedding: data.data[0].embedding,
        tokens: data.usage.total_tokens,
      };
    } catch (e) {
      lastErr = e;
      const aborted = (e as Error)?.name === "AbortError";
      console.warn(
        `generateEmbedding attempt ${attempt}/2 failed` +
          `${aborted ? ` (timed out after ${EMBEDDING_TIMEOUT_MS}ms)` : ""}: ` +
          `${(e as Error)?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `OpenAI embeddings failed after 2 attempts: ${(lastErr as Error)?.message}`,
  );
}
