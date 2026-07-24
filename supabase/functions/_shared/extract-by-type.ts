import { callClaude, imageBlock, pdfDocumentBlock, textBlock } from "./claude-client.ts";
import { loadActivePrompt } from "./load-prompt.ts";
import { renderTemplate } from "./render-template.ts";
import { extractDocText } from "./docx-utils.ts";
import { copyPageRange, loadPdf } from "./pdf-utils.ts";
import { mimeTypeFor } from "./file-type.ts";
import type { FileType } from "./file-type.ts";
import { assertNotTruncated, parseClaudeJson } from "./claude-parse.ts";

// Per-call timeout for evidence-extraction Claude requests (Haiku on one doc / image /
// PDF section). Bounds a truly stalled request so it aborts + retries instead of hanging
// a worker forever. MEASURED: a real 10-page PDF section takes ~52–75s to extract (verified
// against the live API). The old 60s ceiling was SHORTER than that, so normal sections were
// aborted mid-generation, retried 3×, and finally skipped — turning a ~90s job into 480s+ of
// thrashing and "1 file failed". Raised to 120s so a normal section completes in one attempt;
// only a genuinely hung call (never returns) still trips it. NOT applied to run-audit's Opus.
const EXTRACT_TIMEOUT_MS = Math.max(
  10_000,
  Number(Deno.env.get("EXTRACT_TIMEOUT_MS") ?? "120000"),
);

// How many pdf_large CHUNKS to extract at once. A big PDF (e.g. 110 pages → 22
// chunks at PDF_PAGES_PER_CHUNK) used to extract its chunks ONE AT A TIME, so the
// total wall-clock = sum of all chunk calls — which blew past the ~150s edge limit
// and got the invocation killed mid-loop, leaving the file stuck "processing"
// forever. Running chunks with bounded concurrency cuts wall-clock to roughly
// ceil(chunks / N) batches, so a large PDF finishes within the per-file timeout
// and its content actually makes it into the audit. Env-overridable for tuning.
const PDF_CHUNK_CONCURRENCY = Math.max(
  1,
  Number(Deno.env.get("PDF_CHUNK_CONCURRENCY") ?? "12"),
);

// How many times to try a single pdf_large chunk. Haiku occasionally emits
// INVALID JSON (e.g. `"Query" (executed)` — a parenthetical tacked after a quoted
// string), which the parser can't read. A fresh attempt usually returns clean JSON.
// Same "retry once on parse failure" idea already used for the run-audit verdict.
const PDF_CHUNK_MAX_ATTEMPTS = Math.max(
  1,
  Number(Deno.env.get("PDF_CHUNK_MAX_ATTEMPTS") ?? "3"),
);

// Pages per SECTION for a big (>50 page) PDF. We split into sections this size and
// run each through the SAME fast single-call extractor as a small PDF, then combine
// the section results mechanically (no slow LLM aggregator). Kept SMALL: extraction
// generates roughly a fixed amount of output per page, so a bigger section = a bigger,
// SLOWER single call. Small sections each finish fast and all run in parallel, so the
// whole PDF's wall-clock ≈ one section's time. 10 pages ≈ ~50s/section → a 110-page
// PDF (11 sections, all parallel) finishes in ~1 min. Env-overridable for tuning.
const PDF_SECTION_PAGES = Math.max(
  1,
  Number(Deno.env.get("PDF_SECTION_PAGES") ?? "10"),
);

// Parallelism for GIANT documents (>12 sections ≈ >120 pages). Full fan-out on
// a 150+ page report holds too many section bodies in memory at once.
const PDF_CHUNK_CONCURRENCY_LARGE = Math.max(
  1,
  Number(Deno.env.get("PDF_CHUNK_CONCURRENCY_LARGE") ?? "4"),
);

// Absolute page ceiling — beyond this we fail politely and ask for the file to
// be split, rather than grinding a worker for many minutes.
const PDF_MAX_PAGES = Math.max(
  60,
  Number(Deno.env.get("PDF_MAX_PAGES") ?? "400"),
);

// The control + TSC context that every extractor prompt needs at minimum.
// Per-prompt placeholders (evidence_text, pdf_text, image_text, evidence_name,
// chunk_number, total_chunks, chunk_extractions) are filled in by the dispatcher.
export interface ExtractionContext {
  control_description: string;
  expected_procedures: string;
  tscs: string;
  filename: string;
}

export interface ExtractionResult {
  extracted_content: Record<string, unknown>;
  raw_extracted_text: string;
  scratchpad: string | null;
  extractor_prompt_id: string;       // FK target — for pdf_large this is the aggregator
  total_input_tokens: number;
  total_output_tokens: number;
}

// Used everywhere a prompt has a binary-content placeholder ({{pdf_text}},
// {{image_text}}, or {{evidence_text}} when the source is a binary file).
// Multimodal delivers the actual content; this just keeps the prompt grammatical.
const BINARY_PLACEHOLDER =
  "(provided as an attached document — read the attached file directly)";

// JSON + scratchpad parsing now lives in _shared/claude-parse.ts.

export async function extractByType(args: {
  fileType: FileType;
  bytes: Uint8Array;
  context: ExtractionContext;
}): Promise<ExtractionResult> {
  switch (args.fileType) {
    case "csv":       return extractCsv(args.bytes, args.context);
    case "doc":       return extractDoc(args.bytes, args.context);
    case "image":     return extractImage(args.bytes, args.context);
    case "pdf_small": return extractPdfSmall(args.bytes, args.context);
    case "pdf_large": return extractPdfLarge(args.bytes, args.context);
  }
}

async function extractCsv(
  bytes: Uint8Array,
  ctx: ExtractionContext,
): Promise<ExtractionResult> {
  const prompt = await loadActivePrompt("extractor_csv");
  const evidenceText = new TextDecoder().decode(bytes);

  const userText = renderTemplate(prompt.user_prompt_template, {
    control_description: ctx.control_description,
    expected_procedures: ctx.expected_procedures,
    tscs: ctx.tscs,
    evidence_name: ctx.filename,
    evidence_text: evidenceText,
  });

  const claude = await callClaude({
    model: prompt.model,
    system: prompt.system_prompt,
    user: userText,
    max_tokens: prompt.max_tokens,
    timeout_ms: EXTRACT_TIMEOUT_MS,
  });

  assertNotTruncated({
    stop_reason: claude.stop_reason,
    model: prompt.model,
    max_tokens: prompt.max_tokens,
    context: `prompt_key=${prompt.prompt_key}`,
  });
  const { scratchpad, parsed } = parseClaudeJson(claude.text);
  return {
    extracted_content: parsed,
    raw_extracted_text: claude.text,
    scratchpad,
    extractor_prompt_id: prompt.prompt_id,
    total_input_tokens: claude.input_tokens,
    total_output_tokens: claude.output_tokens,
  };
}

async function extractDoc(
  bytes: Uint8Array,
  ctx: ExtractionContext,
): Promise<ExtractionResult> {
  const prompt = await loadActivePrompt("extractor_doc");
  const evidenceText = await extractDocText(ctx.filename, bytes);

  const userText = renderTemplate(prompt.user_prompt_template, {
    control_description: ctx.control_description,
    expected_procedures: ctx.expected_procedures,
    tscs: ctx.tscs,
    evidence_name: ctx.filename,
    evidence_text: evidenceText,
  });

  const claude = await callClaude({
    model: prompt.model,
    system: prompt.system_prompt,
    user: userText,
    max_tokens: prompt.max_tokens,
    timeout_ms: EXTRACT_TIMEOUT_MS,
  });

  assertNotTruncated({
    stop_reason: claude.stop_reason,
    model: prompt.model,
    max_tokens: prompt.max_tokens,
    context: `prompt_key=${prompt.prompt_key}`,
  });
  const { scratchpad, parsed } = parseClaudeJson(claude.text);
  return {
    extracted_content: parsed,
    raw_extracted_text: claude.text,
    scratchpad,
    extractor_prompt_id: prompt.prompt_id,
    total_input_tokens: claude.input_tokens,
    total_output_tokens: claude.output_tokens,
  };
}

async function extractImage(
  bytes: Uint8Array,
  ctx: ExtractionContext,
): Promise<ExtractionResult> {
  const prompt = await loadActivePrompt("extractor_image");

  const userText = renderTemplate(prompt.user_prompt_template, {
    control_description: ctx.control_description,
    expected_procedures: ctx.expected_procedures,
    tscs: ctx.tscs,
    evidence_name: ctx.filename,
    image_text: BINARY_PLACEHOLDER,
  });

  const mt = mimeTypeFor(ctx.filename);
  if (
    mt !== "image/png" && mt !== "image/jpeg" &&
    mt !== "image/gif" && mt !== "image/webp"
  ) {
    throw new Error(`Unsupported image mime type: ${mt}`);
  }

  let claude;
  try {
    claude = await callClaude({
      model: prompt.model,
      system: prompt.system_prompt,
      user: [imageBlock(bytes, mt), textBlock(userText)],
      max_tokens: prompt.max_tokens,
      timeout_ms: EXTRACT_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // The API rejects empty/corrupt image payloads with a 400 invalid_request_error
    // mentioning image.source — surface that as a fix-the-file instruction instead
    // of the raw API JSON.
    if (msg.includes("image") && (msg.includes("invalid_request_error") || msg.includes("400"))) {
      throw new Error(
        `🖼️ '${ctx.filename}' appears to be an empty or corrupted image — please replace ` +
          `it in Drive with a valid screenshot/photo and re-run.`,
      );
    }
    throw err;
  }

  assertNotTruncated({
    stop_reason: claude.stop_reason,
    model: prompt.model,
    max_tokens: prompt.max_tokens,
    context: `prompt_key=${prompt.prompt_key}`,
  });
  const { scratchpad, parsed } = parseClaudeJson(claude.text);
  return {
    extracted_content: parsed,
    raw_extracted_text: claude.text,
    scratchpad,
    extractor_prompt_id: prompt.prompt_id,
    total_input_tokens: claude.input_tokens,
    total_output_tokens: claude.output_tokens,
  };
}

async function extractPdfSmall(
  bytes: Uint8Array,
  ctx: ExtractionContext,
): Promise<ExtractionResult> {
  const prompt = await loadActivePrompt("extractor_pdf_small");

  const userText = renderTemplate(prompt.user_prompt_template, {
    control_description: ctx.control_description,
    expected_procedures: ctx.expected_procedures,
    tscs: ctx.tscs,
    evidence_name: ctx.filename,
    pdf_text: BINARY_PLACEHOLDER,
  });

  const claude = await callClaude({
    model: prompt.model,
    system: prompt.system_prompt,
    user: [pdfDocumentBlock(bytes), textBlock(userText)],
    max_tokens: prompt.max_tokens,
    timeout_ms: EXTRACT_TIMEOUT_MS,
  });

  assertNotTruncated({
    stop_reason: claude.stop_reason,
    model: prompt.model,
    max_tokens: prompt.max_tokens,
    context: `prompt_key=${prompt.prompt_key}`,
  });
  const { scratchpad, parsed } = parseClaudeJson(claude.text);
  return {
    extracted_content: parsed,
    raw_extracted_text: claude.text,
    scratchpad,
    extractor_prompt_id: prompt.prompt_id,
    total_input_tokens: claude.input_tokens,
    total_output_tokens: claude.output_tokens,
  };
}

async function extractPdfLarge(
  bytes: Uint8Array,
  ctx: ExtractionContext,
): Promise<ExtractionResult> {
  // Split a big PDF into PDF_SECTION_PAGES-page SECTIONS and run each through the SAME
  // fast single-call path used for a small PDF, in parallel — then combine the section
  // results MECHANICALLY (no extra LLM call).
  //
  // LAZY splitting (Batch Test 05 hardening): sections are serialized ON DEMAND,
  // one at a time, right before their API call — never all up-front. Building
  // every section eagerly held all their bytes at once and did the whole
  // pdf-lib CPU work in one burst, which got the worker killed mid-file on
  // 150+ page vendor reports (a real 189-page SOC 2 report measured ×4.5 byte
  // blowup and multi-second CPU). The split mutex below keeps pdf-lib's shared
  // source parsing single-file while API calls still overlap.
  let source;
  try {
    source = await loadPdf(bytes);
  } catch {
    throw new Error(
      `'${ctx.filename}' is not a readable PDF — it appears corrupt or was saved/renamed ` +
        `incorrectly. Please re-export it as a standard PDF and re-upload.`,
    );
  }
  const totalPages = source.getPageCount();
  if (totalPages > PDF_MAX_PAGES) {
    throw new Error(
      `'${ctx.filename}' has ${totalPages} pages — too large to process as one file. ` +
        `Please split it into parts of ~100 pages each in Drive, or upload a ` +
        `spreadsheet/text version of the report.`,
    );
  }
  const totalSections = Math.ceil(totalPages / PDF_SECTION_PAGES);

  // Sections are produced strictly one at a time (CPU-bound; parallel copies of a
  // shared pdf-lib doc gain nothing and risk its internal caches interleaving).
  let splitTail: Promise<unknown> = Promise.resolve();
  const sectionBytes = (i: number): Promise<Uint8Array> => {
    const p = splitTail.then(() =>
      copyPageRange(source, i * PDF_SECTION_PAGES, (i + 1) * PDF_SECTION_PAGES)
    );
    splitTail = p.catch(() => {});
    return p;
  };

  // Load the small-PDF extractor once; every section uses it.
  const prompt = await loadActivePrompt("extractor_pdf_small");

  interface SectionRecord {
    section: number;
    extracted_content: Record<string, unknown>;
    scratchpad: string | null;
    raw: string;
    input: number;
    output: number;
  }

  const slots: SectionRecord[] = new Array(totalSections);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= totalSections) return;

      // Serialize THIS section's pages now — its bytes live only for this loop turn.
      let secBytes: Uint8Array;
      try {
        secBytes = await sectionBytes(i);
      } catch (err) {
        console.error(
          `pdf_large section ${i + 1}/${totalSections} could not be split: ` +
            `${(err as Error).message.slice(0, 160)}`,
        );
        slots[i] = {
          section: i + 1,
          extracted_content: {
            section_skipped: true,
            section_number: i + 1,
            total_sections: totalSections,
            reason: "section could not be extracted from the PDF",
          },
          scratchpad: null,
          raw: "",
          input: 0,
          output: 0,
        };
        continue;
      }

      const userText = renderTemplate(prompt.user_prompt_template, {
        control_description: ctx.control_description,
        expected_procedures: ctx.expected_procedures,
        tscs: ctx.tscs,
        evidence_name: `${ctx.filename} (section ${i + 1}/${totalSections})`,
        pdf_text: BINARY_PLACEHOLDER,
      });

      // Retry a section a few times — a fresh call usually fixes a one-off bad-JSON
      // or transient timeout response.
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= PDF_CHUNK_MAX_ATTEMPTS; attempt++) {
        try {
          const claude = await callClaude({
            model: prompt.model,
            system: prompt.system_prompt,
            user: [pdfDocumentBlock(secBytes), textBlock(userText)],
            max_tokens: prompt.max_tokens,
            timeout_ms: EXTRACT_TIMEOUT_MS,
          });
          assertNotTruncated({
            stop_reason: claude.stop_reason,
            model: prompt.model,
            max_tokens: prompt.max_tokens,
            context: `prompt_key=${prompt.prompt_key} section=${i + 1}/${totalSections}`,
          });
          const { scratchpad, parsed } = parseClaudeJson(claude.text);
          slots[i] = {
            section: i + 1,
            extracted_content: parsed,
            scratchpad,
            raw: claude.text,
            input: claude.input_tokens,
            output: claude.output_tokens,
          };
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err as Error;
          console.warn(
            `pdf_large section ${i + 1}/${totalSections} attempt ${attempt}/` +
              `${PDF_CHUNK_MAX_ATTEMPTS} failed: ${lastErr.message.slice(0, 160)}`,
          );
        }
      }
      // Still failing after every attempt — SKIP just this section instead of failing
      // the whole PDF, so the other sections still reach the audit.
      if (lastErr) {
        console.error(
          `pdf_large section ${i + 1}/${totalSections} SKIPPED after ` +
            `${PDF_CHUNK_MAX_ATTEMPTS} attempts: ${lastErr.message.slice(0, 160)}`,
        );
        slots[i] = {
          section: i + 1,
          extracted_content: {
            section_skipped: true,
            section_number: i + 1,
            total_sections: totalSections,
            reason: "unparseable extractor output after retries",
          },
          scratchpad: null,
          raw: "",
          input: 0,
          output: 0,
        };
      }
    }
  };
  // Giant documents get LOWER parallelism: each in-flight section holds its
  // bytes + base64 request body in memory, and a 150+ page report at full
  // fan-out is exactly the profile that used to kill workers.
  const sectionConcurrency = totalSections > 12
    ? PDF_CHUNK_CONCURRENCY_LARGE
    : PDF_CHUNK_CONCURRENCY;
  await Promise.all(
    Array.from({ length: Math.min(sectionConcurrency, totalSections) }, () => worker()),
  );

  const totalInput = slots.reduce((sum, s) => sum + s.input, 0);
  const totalOutput = slots.reduce((sum, s) => sum + s.output, 0);

  // Combine the section extractions MECHANICALLY (no LLM aggregation). The audit
  // reads the whole extracted_content JSON, so it sees every section's evidence.
  return {
    extracted_content: {
      document_type: "large_pdf_sections",
      total_sections: totalSections,
      pages_per_section: PDF_SECTION_PAGES,
      sections: slots.map((s) => ({ section: s.section, ...s.extracted_content })),
    },
    raw_extracted_text: slots.map((s) => s.raw).join("\n\n=== SECTION BREAK ===\n\n"),
    scratchpad: JSON.stringify({
      section_count: totalSections,
      pages_per_section: PDF_SECTION_PAGES,
      section_scratchpads: slots.map((s) => ({ section: s.section, scratchpad: s.scratchpad })),
    }),
    extractor_prompt_id: prompt.prompt_id,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
  };
}
