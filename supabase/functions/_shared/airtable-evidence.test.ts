// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals } from "jsr:@std/assert@^1";
import { parseAirtableEvidenceAttachments } from "./airtable-evidence.ts";

Deno.test("normalizes valid V3_Evidence attachments", () => {
  assertEquals(
    parseAirtableEvidenceAttachments([
      {
        id: "attOne",
        url: "https://dl.airtable.com/file-one",
        filename: "SOC 2.pdf.pdf",
        type: "application/pdf",
        size: 189000,
      },
      {
        url: "https://dl.airtable.com/file-two",
        filename: "sample.txt",
      },
    ]),
    [
      {
        id: "attOne",
        url: "https://dl.airtable.com/file-one",
        filename: "SOC 2.pdf.pdf",
        mimeType: "application/pdf",
        size: 189000,
      },
      {
        id: null,
        url: "https://dl.airtable.com/file-two",
        filename: "sample.txt",
        mimeType: "text/plain",
      },
    ],
  );
});

Deno.test("ignores malformed or unsafe V3_Evidence values", () => {
  assertEquals(
    parseAirtableEvidenceAttachments([
      null,
      { url: "javascript:alert(1)", filename: "bad.pdf" },
      { url: "https://dl.airtable.com/no-name" },
      { filename: "no-url.pdf" },
    ]),
    [],
  );
  assertEquals(parseAirtableEvidenceAttachments("not-an-attachment-array"), []);
});
