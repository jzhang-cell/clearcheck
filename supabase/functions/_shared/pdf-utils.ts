import { PDFDocument } from "npm:pdf-lib@^1.17";

export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

// Parse once, reuse for many page-range copies. Callers that need several
// sections of the same document should load once and call copyPageRange per
// section instead of splitPdfIntoChunks — building EVERY section up-front
// (bytes for all of them resident at once, one long CPU burst) is what got
// workers killed on 150+ page documents (Batch Test 05, CC.09.04).
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return await PDFDocument.load(bytes, { ignoreEncryption: true });
}

// Serialize pages [start, end) of an already-loaded document into a standalone
// PDF. One section's bytes exist only while the caller holds them.
export async function copyPageRange(
  source: PDFDocument,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const total = source.getPageCount();
  const from = Math.max(0, start);
  const to = Math.min(end, total);
  if (from >= to) throw new Error(`copyPageRange: empty range [${start}, ${end}) of ${total}`);
  const chunk = await PDFDocument.create();
  const indices = Array.from({ length: to - from }, (_, i) => from + i);
  const copied = await chunk.copyPages(source, indices);
  copied.forEach((p) => chunk.addPage(p));
  return await chunk.save();
}

export async function splitPdfIntoChunks(
  bytes: Uint8Array,
  pagesPerChunk: number,
): Promise<Uint8Array[]> {
  if (pagesPerChunk < 1) throw new Error("pagesPerChunk must be >= 1");

  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const totalPages = source.getPageCount();
  const chunks: Uint8Array[] = [];

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const chunk = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await chunk.copyPages(source, indices);
    copied.forEach((p) => chunk.addPage(p));
    chunks.push(await chunk.save());
  }

  return chunks;
}
