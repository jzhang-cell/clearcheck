export function asOptionalProviderExecutionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

export function asOptionalProviderExecutionUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length > 2_000) {
    throw new Error("'provider_execution_url' must be 2000 characters or fewer");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("'provider_execution_url' must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("'provider_execution_url' must be a valid HTTP(S) URL");
  }
  return trimmed;
}
