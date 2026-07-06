import { PDFDocument } from "npm:pdf-lib@^1.17";

export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
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
