// Parses Claude's text output into a structured result.
//
// Layered strategy:
//   1. Extract <scratchpad>...</scratchpad> blocks (V2 chain-of-thought pattern)
//      and remove them from the working text.
//   2. Try direct JSON.parse on the remainder.
//   3. Recursively strip outermost code fences (```xml, ```json, ```,
//      ```markdown, etc.) up to 3 nesting levels, trying parse after each.
//      This handles Claude wrapping its full response in an outer language
//      fence (e.g. ```xml ... ```json {...} ``` ... ```).
//   4. Fallback: greedy {...} regex on the deepest unwrap and on the original
//      cleaned text.
//   5. On total failure, throw with the FULL cleaned remainder (no truncation)
//      so failed runs can be diagnosed end-to-end via job_runs.error_message.

export interface ClaudeParseResult {
  scratchpad: string | null;
  parsed: Record<string, unknown>;
}

const SCRATCHPAD_RE = /<scratchpad>([\s\S]*?)<\/scratchpad>/gi;
// Match a code fence wrapping the entire trimmed string.
// Opening: ``` followed by optional language tag (alphanumeric + a few chars).
// Closing: ``` at end.
const OUTER_FENCE_RE = /^```[a-zA-Z0-9_-]*\r?\n?([\s\S]*?)\r?\n?```$/;
const OBJECT_RE = /\{[\s\S]*\}/;
const MAX_FENCE_STRIP_DEPTH = 3;

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function stripOuterFence(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(OUTER_FENCE_RE);
  return m ? m[1].trim() : null;
}

export function parseClaudeJson(text: string): ClaudeParseResult {
  // 1. Extract and strip <scratchpad> blocks.
  const scratchpads: string[] = [];
  const cleaned = text
    .replace(SCRATCHPAD_RE, (_match, content: string) => {
      const trimmed = content.trim();
      if (trimmed.length > 0) scratchpads.push(trimmed);
      return "";
    })
    .trim();

  const scratchpad = scratchpads.length > 0 ? scratchpads.join("\n\n") : null;

  // 2. Direct parse.
  let parsed = tryParseObject(cleaned);
  if (parsed) return { scratchpad, parsed };

  // 3. Recursive outer-fence stripping. After each strip, try parse again.
  let unwrapped = cleaned;
  for (let depth = 0; depth < MAX_FENCE_STRIP_DEPTH; depth++) {
    const next = stripOuterFence(unwrapped);
    if (next === null) break;
    unwrapped = next;
    parsed = tryParseObject(unwrapped);
    if (parsed) return { scratchpad, parsed };
  }

  // 4. Greedy {...} regex on the deepest unwrap, then fall back to cleaned.
  for (const candidate of [unwrapped, cleaned]) {
    const m = candidate.match(OBJECT_RE);
    if (m) {
      parsed = tryParseObject(m[0]);
      if (parsed) return { scratchpad, parsed };
    }
  }

  // 5. Failure — include FULL cleaned remainder for diagnosis (no truncation).
  throw new Error(
    `Could not parse JSON object from Claude output. ` +
      `After stripping ${scratchpads.length} scratchpad block(s), ` +
      `cleaned remainder (${cleaned.length} chars):\n${cleaned}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Audit-judge response parsing (XML tags inside <scratchpad>, not JSON)
// ─────────────────────────────────────────────────────────────────────

export interface AuditParseResult {
  scratchpad: string; // full scratchpad body (stored in audit_results.root_cause_analysis)
  conformity_level: string; // <conformity_level>
  conformity_status: string; // derived from conformity_level via the table below
  root_cause_category: string; // <root_cause>
  conformity_determination: string; // <determination> — markdown
  conformity_briefing: string; // <briefing> — markdown
  potential_clarifications: string; // <clarifications> — markdown
}

// Em-dash sensitive. The audit_judge prompt uses U+2014 in its allowed values.
// "Incomplete Assessment" is remediation-only (audit_remediation Rule 11 —
// unreadable/wrong-file-type evidence); the initial audit_judge never emits it.
const CONFORMITY_LEVEL_TO_STATUS: Record<string, string> = {
  "No Deviation": "Conforming",
  "Observation — Evidence Requested": "Observation",
  "Observation — Informational": "Observation",
  "Observation — Control Ambiguity": "Observation",
  "Deviation": "Deviation",
  "Incomplete Assessment": "Incomplete Assessment",
};

// Airtable's V3_Conformity_Level is a 3-option dropdown: "No Deviation" /
// "Deviation" / "Pending conclusion". "No Deviation" and "Deviation" pass
// through unchanged; every other granular level (Observation — …, Incomplete
// Assessment) collapses to "Pending conclusion". The full granular level
// survives in audit_results and in the V3_Determination text. A singleSelect
// PATCH with any other value would 422 and take the whole write-back down
// with it.
const DROPDOWN_PASSTHROUGH_LEVELS = new Set(["No Deviation", "Deviation"]);

export function conformityLevelToDropdown(level: string): string {
  return DROPDOWN_PASSTHROUGH_LEVELS.has(level) ? level : "Pending conclusion";
}

const REQUIRED_AUDIT_TAGS = [
  "conformity_level",
  "root_cause",
  "determination",
  "briefing",
  "clarifications",
] as const;

function extractTag(text: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function parseAuditResponse(text: string): AuditParseResult {
  // 1. Strip outer code fences (recursive, up to MAX_FENCE_STRIP_DEPTH).
  let unwrapped = text.trim();
  for (let depth = 0; depth < MAX_FENCE_STRIP_DEPTH; depth++) {
    const next = stripOuterFence(unwrapped);
    if (next === null) break;
    unwrapped = next;
  }

  // 2. Find the <scratchpad>...</scratchpad> block if present. The prompt asks
  //    for the verdict tags INSIDE the scratchpad, but the model sometimes
  //    closes the scratchpad first and emits the tags after it, or omits the
  //    wrapper entirely. So the scratchpad is OPTIONAL here (kept only for
  //    storage) and the tags are searched across the WHOLE response below.
  const scratchpadBlock = extractTag(unwrapped, "scratchpad");

  // 3. Pull each required tag from the FULL response (tolerant of whether the
  //    tag sits inside or after the scratchpad).
  const tagValues: Record<string, string | null> = {};
  for (const tag of REQUIRED_AUDIT_TAGS) {
    tagValues[tag] = extractTag(unwrapped, tag);
  }

  const missing = REQUIRED_AUDIT_TAGS.filter((t) => tagValues[t] === null);
  if (missing.length > 0) {
    throw new Error(
      `audit_judge response missing required tag(s): ${missing.join(", ")}. ` +
        `Full response (${unwrapped.length} chars):\n${unwrapped}`,
    );
  }

  // scratchpad value for storage: the block if the model wrapped one, else the
  // whole response (so root_cause_analysis still captures the reasoning).
  const scratchpad = scratchpadBlock ?? unwrapped;

  // 4. Derive conformity_status from conformity_level.
  const conformityLevel = tagValues.conformity_level!;
  const conformityStatus = CONFORMITY_LEVEL_TO_STATUS[conformityLevel];
  if (!conformityStatus) {
    throw new Error(
      `Unknown <conformity_level> value: '${conformityLevel}'. ` +
        `Allowed: ${Object.keys(CONFORMITY_LEVEL_TO_STATUS).join(" | ")}. ` +
        `(Em-dash is U+2014; check for hyphen/em-dash mismatch.)`,
    );
  }

  return {
    scratchpad,
    conformity_level: conformityLevel,
    conformity_status: conformityStatus,
    root_cause_category: tagValues.root_cause!,
    conformity_determination: tagValues.determination!,
    conformity_briefing: tagValues.briefing!,
    potential_clarifications: tagValues.clarifications!,
  };
}

// Throws a clear error if Claude's response was cut off at max_tokens.
// Without this, callers see a cryptic JSON parse failure instead of the real
// problem (the JSON ends mid-value with no closing }).
export function assertNotTruncated(args: {
  stop_reason: string;
  model: string;
  max_tokens: number;
  context?: string;
}): void {
  if (args.stop_reason === "max_tokens") {
    throw new Error(
      `Claude output truncated at max_tokens=${args.max_tokens} ` +
        `(model=${args.model}, stop_reason=max_tokens` +
        (args.context ? `, ${args.context}` : "") +
        `). Output cut off mid-response. ` +
        `Bump max_tokens in the prompt's frontmatter or shorten the expected output.`,
    );
  }
}
