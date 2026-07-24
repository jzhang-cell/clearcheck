// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { detectFileType, hasPdfHeader } from "./file-type.ts";

Deno.test("recognizes a PDF signature near the start of a file", () => {
  const bytes = new TextEncoder().encode("\n%PDF-1.7\n");
  assertEquals(hasPdfHeader(bytes), true);
  assertEquals(hasPdfHeader(new TextEncoder().encode("<html>not a PDF</html>")), false);
});

Deno.test("routes genuine but locally unsupported double-extension PDFs externally", async () => {
  const unsupportedPdf = new TextEncoder().encode("%PDF-1.7\nnot a complete local-parser PDF");
  assertEquals(
    await detectFileType("encrypted-report.pdf.pdf", unsupportedPdf),
    "pdf_large",
  );
});

Deno.test("still rejects non-PDF bytes renamed with a PDF extension", async () => {
  const renamedHtml = new TextEncoder().encode("<html><body>download error</body></html>");
  await assertRejects(
    () => detectFileType("download.pdf.pdf", renamedHtml),
    Error,
    "not a readable PDF",
  );
});
