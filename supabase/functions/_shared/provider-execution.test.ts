// deno-lint-ignore-file no-import-prefix -- matches the repository's existing test imports.
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  asOptionalProviderExecutionId,
  asOptionalProviderExecutionUrl,
} from "./provider-execution.ts";

Deno.test("normalizes optional provider execution metadata", () => {
  assertEquals(asOptionalProviderExecutionId("  run-123  "), "run-123");
  assertEquals(
    asOptionalProviderExecutionUrl("  https://us1.make.com/123/scenarios/456/history/789  "),
    "https://us1.make.com/123/scenarios/456/history/789",
  );
  assertEquals(asOptionalProviderExecutionUrl(""), null);
});

Deno.test("rejects non-HTTP provider execution URLs", () => {
  assertThrows(
    () => asOptionalProviderExecutionUrl("javascript:alert(1)"),
    Error,
    "valid HTTP(S) URL",
  );
  assertThrows(
    () => asOptionalProviderExecutionUrl("not a URL"),
    Error,
    "valid HTTP(S) URL",
  );
});
