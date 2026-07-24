import { countPdfPages } from "./pdf-utils.ts";

export type FileType = "csv" | "pdf_small" | "pdf_large" | "image" | "doc";

export const PDF_LARGE_THRESHOLD = 50;
export const PDF_PAGES_PER_CHUNK = 5;

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "m4v"]);

// The PDF header must appear near the beginning of the file. Checking the
// binary signature lets us distinguish a genuine but locally unsupported PDF
// (for example AES-256 encrypted) from HTML or another file merely renamed
// with a .pdf extension.
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const searchLimit = Math.min(bytes.length - signature.length + 1, 1024);
  for (let offset = 0; offset < searchLimit; offset++) {
    let matches = true;
    for (let index = 0; index < signature.length; index++) {
      if (bytes[offset + index] !== signature[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

export async function detectFileType(
  filename: string,
  bytes: Uint8Array,
): Promise<FileType> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "pdf") {
    let pages: number;
    try {
      pages = await countPdfPages(bytes);
    } catch (error) {
      if (hasPdfHeader(bytes)) {
        // Some genuine PDFs (notably AES-256 encrypted files with copy
        // restrictions) cannot be parsed by pdf-lib. Classify them as large so
        // the durable Make path can attempt external extraction instead of
        // rejecting them based on the local parser's limitations.
        console.warn(
          `Local PDF inspection failed for '${filename}'; routing to external extraction: ${
            (error as Error).message
          }`,
        );
        return "pdf_large";
      }
      // No PDF signature: this is usually a web page or another file renamed
      // with a .pdf extension.
      throw new Error(
        `'${filename}' is not a readable PDF — it appears corrupt or was saved/renamed ` +
          `incorrectly. Please re-export it as a standard PDF and re-upload.`,
      );
    }
    return pages > PDF_LARGE_THRESHOLD ? "pdf_large" : "pdf_small";
  }
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
    return "image";
  }
  if (ext === "docx" || ext === "doc" || ext === "txt" || ext === "md") return "doc";

  if (VIDEO_EXTENSIONS.has(ext)) {
    throw new Error(
      `🎬 Video files can't be read as audit evidence ('${filename}'). Please provide ` +
        `documents, spreadsheets, or screenshots instead.`,
    );
  }
  throw new Error(
    `Files of type '.${ext}' can't be read as audit evidence ('${filename}'). Supported: ` +
      `PDF, Word (docx), CSV/Excel, text, and images (PNG/JPG).`,
  );
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
    case "csv":
      return "extractor_csv";
    case "pdf_small":
      return "extractor_pdf_small";
    case "image":
      return "extractor_image";
    case "doc":
      return "extractor_doc";
    case "pdf_large":
      return "extractor_pdf_aggregator";
  }
}
