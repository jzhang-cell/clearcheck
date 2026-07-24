import {
  type ExternalExtractionStatus,
  externalFileLocator,
  summarizeExternalJobs,
} from "./external-extraction.ts";

function jobs(
  statuses: ExternalExtractionStatus[],
): { status: ExternalExtractionStatus; error_message: string | null }[] {
  return statuses.map((status) => ({ status, error_message: null }));
}

Deno.test("external summary is none when this sync has no Make jobs", () => {
  const result = summarizeExternalJobs([]);
  if (result.state !== "none" || result.total !== 0) throw new Error(JSON.stringify(result));
});

Deno.test("external summary waits for queued, processing, and completing jobs", () => {
  const result = summarizeExternalJobs(jobs(["queued", "processing", "completing", "completed"]));
  if (result.state !== "waiting" || result.waiting !== 3 || result.completed !== 1) {
    throw new Error(JSON.stringify(result));
  }
});

Deno.test("external summary is ready only when every job completed", () => {
  const result = summarizeExternalJobs(jobs(["completed", "completed"]));
  if (result.state !== "ready" || result.completed !== 2) throw new Error(JSON.stringify(result));
});

Deno.test("one failed Make job stops the whole sync", () => {
  const result = summarizeExternalJobs([
    { status: "completed", error_message: null },
    { status: "failed", error_message: "PDF extractor rejected the file" },
    { status: "processing", error_message: null },
  ]);
  if (result.state !== "failed" || result.failed !== 1) throw new Error(JSON.stringify(result));
  if (result.errors[0] !== "PDF extractor rejected the file") {
    throw new Error(JSON.stringify(result));
  }
});

Deno.test("external extraction prefers a Google Drive locator", () => {
  const result = externalFileLocator({
    google_drive_file_id: " drive-file-1 ",
    download_url: "https://example.com/fallback.pdf",
  });
  if (
    result.source !== "google_drive" ||
    result.google_drive_file_id !== "drive-file-1" ||
    result.download_url !== null
  ) {
    throw new Error(JSON.stringify(result));
  }
});

Deno.test("external extraction accepts a download URL for Airtable evidence", () => {
  const result = externalFileLocator({
    download_url: "https://project.supabase.co/storage/v1/object/sign/evidence/report.pdf?token=x",
  });
  if (
    result.source !== "download_url" ||
    result.google_drive_file_id !== null ||
    !result.download_url?.startsWith("https://project.supabase.co/")
  ) {
    throw new Error(JSON.stringify(result));
  }
});

Deno.test("external extraction rejects missing or unsafe locators", () => {
  let missing = "";
  try {
    externalFileLocator({});
  } catch (error) {
    missing = (error as Error).message;
  }
  if (!missing.includes("requires")) throw new Error(`Unexpected error: ${missing}`);

  let unsafe = "";
  try {
    externalFileLocator({ download_url: "javascript:alert(1)" });
  } catch (error) {
    unsafe = (error as Error).message;
  }
  if (!unsafe.includes("HTTP or HTTPS")) throw new Error(`Unexpected error: ${unsafe}`);
});
