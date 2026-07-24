// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals } from "jsr:@std/assert@^1";
import { getAirtableRecord, patchAirtableRecord, unknownAirtableFieldName } from "./airtable.ts";

Deno.test("extracts an Airtable UNKNOWN_FIELD_NAME safely", () => {
  assertEquals(
    unknownAirtableFieldName(
      JSON.stringify({
        error: {
          type: "UNKNOWN_FIELD_NAME",
          message: 'Unknown field name: "V3_Done_At"',
        },
      }),
    ),
    "V3_Done_At",
  );
});

Deno.test("does not treat other Airtable errors as removable fields", () => {
  assertEquals(
    unknownAirtableFieldName(
      JSON.stringify({
        error: {
          type: "INVALID_VALUE_FOR_COLUMN",
          message: 'Field "V3_Done_At" cannot accept the provided value',
        },
      }),
    ),
    null,
  );
  assertEquals(unknownAirtableFieldName("not JSON"), null);
});

Deno.test("retries a PATCH without an unknown field", async () => {
  const originalFetch = globalThis.fetch;
  const originalPat = Deno.env.get("AIRTABLE_PAT");
  const bodies: Record<string, unknown>[] = [];
  Deno.env.set("AIRTABLE_PAT", "test-pat");
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              type: "UNKNOWN_FIELD_NAME",
              message: 'Unknown field name: "Optional_Field"',
            },
          }),
          { status: 422 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  try {
    const result = await patchAirtableRecord({
      baseId: "appTest",
      tableId: "tblTest",
      recordId: "recTest",
      fields: {
        "ClearCheck 💬": "🥳 Audit complete",
        Optional_Field: "optional",
      },
    });
    assertEquals(result.ok, true);
    assertEquals(result.omitted_fields, ["Optional_Field"]);
    assertEquals(bodies, [
      {
        fields: {
          "ClearCheck 💬": "🥳 Audit complete",
          Optional_Field: "optional",
        },
      },
      { fields: { "ClearCheck 💬": "🥳 Audit complete" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPat === undefined) Deno.env.delete("AIRTABLE_PAT");
    else Deno.env.set("AIRTABLE_PAT", originalPat);
  }
});

Deno.test("reads one Airtable record with selected fields", async () => {
  const originalFetch = globalThis.fetch;
  const originalPat = Deno.env.get("AIRTABLE_PAT");
  let requestedUrl = "";
  Deno.env.set("AIRTABLE_PAT", "test-pat");
  globalThis.fetch = ((input: string | URL | Request) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "recTest",
          fields: { V3_Evidence: [{ url: "https://example.com/a.pdf", filename: "a.pdf" }] },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await getAirtableRecord({
      baseId: "appTest",
      tableId: "tblTest",
      recordId: "recTest",
      fields: ["V3_Evidence"],
    });
    assertEquals(result.ok, true);
    assertEquals(result.record?.id, "recTest");
    assertEquals(new URL(requestedUrl).searchParams.getAll("fields[]"), ["V3_Evidence"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPat === undefined) Deno.env.delete("AIRTABLE_PAT");
    else Deno.env.set("AIRTABLE_PAT", originalPat);
  }
});
