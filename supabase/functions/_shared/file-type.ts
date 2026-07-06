import { countPdfPages } from "./pdf-utils.ts";

export type FileType = "csv" | "pdf_small" | "pdf_large" | "image" | "doc";

export const PDF_LARGE_THRESHOLD = 50;
export const PDF_PAGES_PER_CHUNK = 5;

export async function detectFileType(
  filename: string,
  bytes: Uint8Array,
): Promise<FileType> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "pdf") {
    const pages = await countPdfPages(bytes);
    return pages > PDF_LARGE_THRESHOLD ? "pdf_large" : "pdf_small";
  }
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
    return "image";
  }
  if (ext === "docx" || ext === "doc" || ext === "txt" || ext === "md") return "doc";

  throw new Error(`Unsupported file extension '.${ext}' (filename: ${filename})`);
}

export function mimeTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    txt: "text/plain",
    md: "text/markdown",
  };
  return map[ext] ?? "application/octet-stream";
}

// Returns the prompt_key used to look up the *primary* extractor for a file type.
// pdf_large uses two prompts (chunk + aggregator) — this returns the aggregator,
// since that's the one whose extracted_content gets stored as the final result.
export function primaryPromptKeyFor(fileType: FileType): string {
  switch (fileType) {
    case "csv":       return "extractor_csv";
    case "pdf_small": return "extractor_pdf_small";
    case "image":     return "extractor_image";
    case "doc":       return "extractor_doc";
    case "pdf_large": return "extractor_pdf_aggregator";
  }
}
