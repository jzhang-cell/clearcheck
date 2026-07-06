import Anthropic from "npm:@anthropic-ai/sdk@^0.30";
import type { ClaudeCallResult } from "./types.ts";

// Local block-param types matching the API request shape. The SDK doesn't
// export these as a unified `ContentBlockParam` at the top level in 0.30.x,
// so we keep our own structurally-compatible union and cast at the SDK boundary.
export type TextBlockParam = { type: "text"; text: string };
export type ImageBlockParam = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
};
export type DocumentBlockParam = {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
};
export type ContentBlockParam = TextBlockParam | ImageBlockParam | DocumentBlockParam;
export type UserContent = string | ContentBlockParam[];

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (cached) return cached;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  cached = new Anthropic({ apiKey });
  return cached;
}

export async function callClaude(args: {
  model: string;
  system: string | null;
  user: UserContent;
  max_tokens: number;
  temperature?: number;
  // Optional per-request timeout (ms). Set this on FAST calls (e.g. evidence
  // extraction with Haiku) so a stalled request aborts instead of hanging the
  // whole job. Leave unset for slow calls (Opus audit/workpaper) to keep the
  // SDK's generous default — a tight global timeout would break run-audit.
  timeout_ms?: number;
}): Promise<ClaudeCallResult> {
  const c = client();
  const resp = await c.messages.create({
    model: args.model,
    max_tokens: args.max_tokens,
    // Only pass temperature if explicitly provided — preserves Anthropic's
    // default for callers that don't care.
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    system: args.system ?? undefined,
    // Cast at the SDK boundary — our local block types are structurally
    // compatible with what the SDK accepts, but its declared param types
    // live behind a more elaborate union we don't need to reproduce.
    // deno-lint-ignore no-explicit-any
    messages: [{ role: "user", content: args.user as any }],
  }, args.timeout_ms !== undefined ? { timeout: args.timeout_ms } : undefined);

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    text,
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
    stop_reason: resp.stop_reason ?? "unknown",
  };
}

// Helpers for building multimodal content blocks. Use these in callers to
// avoid sprinkling base64-conversion code everywhere.

export function pdfDocumentBlock(bytes: Uint8Array): DocumentBlockParam {
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: bytesToBase64(bytes),
    },
  };
}

export function imageBlock(
  bytes: Uint8Array,
  mediaType: ImageBlockParam["source"]["media_type"],
): ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: bytesToBase64(bytes),
    },
  };
}

export function textBlock(text: string): TextBlockParam {
  return { type: "text", text };
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa works on binary strings; build one chunk-by-chunk to avoid call-stack
  // limits on large payloads (PDFs can easily exceed 100KB).
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
