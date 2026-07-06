// Reads supabase/prompts/*.md and upserts into the `prompts` table.
//
// For each file: deactivate any prior active row with the same prompt_key,
// then upsert the version. The two ops are sequential, not transactional —
// supabase-js can't bundle PostgREST calls into a single PG transaction.
// Ordering preserves the `one_active_prompt_per_key` partial unique index:
// after the UPDATE there's no active row for the key, so the UPSERT can set
// is_active=true without violating the constraint. Worst case if the UPSERT
// fails: the prompt_key has no active row transiently — recoverable by
// re-running.
//
// Usage:
//   deno run --allow-read --allow-env --allow-net scripts/sync-prompts.ts
//
// Env (override to target cloud):
//   SUPABASE_URL              defaults to http://127.0.0.1:54321 (local stack)
//   SUPABASE_SERVICE_ROLE_KEY defaults to the standard local-dev key

import { parse as parseYaml } from "@std/yaml";
import { createClient } from "npm:@supabase/supabase-js@^2";

const PROMPTS_DIR = new URL("../supabase/prompts/", import.meta.url).pathname;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";

// The local-dev service-role key is identical across every supabase-cli local
// stack — it's not a secret. For cloud use, pass the real key via env.
const LOCAL_DEV_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? LOCAL_DEV_SERVICE_ROLE_KEY;

interface Frontmatter {
  prompt_key?: string;
  version?: string;
  model?: string;
  max_tokens?: number;
  is_active?: boolean;
  notes?: string;
}

interface ParsedPrompt {
  prompt_key: string;
  version: string;
  model: string;
  max_tokens: number;
  is_active: boolean;
  notes: string | null;
  system_prompt: string | null;
  user_prompt_template: string;
}

function parsePromptFile(content: string, _filename: string): ParsedPrompt {
  const fmMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) throw new Error("missing or malformed YAML frontmatter");

  const fm = parseYaml(fmMatch[1]) as Frontmatter;
  const body = fmMatch[2];

  if (!fm.prompt_key) throw new Error("frontmatter missing 'prompt_key'");
  if (!fm.version) throw new Error("frontmatter missing 'version'");
  if (!fm.model) throw new Error("frontmatter missing 'model'");

  const userMatch = body.match(/^## User[ \t]*\r?\n([\s\S]*)/m);
  if (!userMatch) throw new Error("missing required '## User' section");

  const sysMatch = body.match(
    /^## System[ \t]*\r?\n([\s\S]+?)(?=^## User[ \t]*\r?\n)/m,
  );

  return {
    prompt_key: fm.prompt_key,
    version: fm.version,
    model: fm.model,
    max_tokens: fm.max_tokens ?? 4096,
    is_active: fm.is_active !== false,
    notes: fm.notes ?? null,
    system_prompt: sysMatch ? sysMatch[1].trim() : null,
    user_prompt_template: userMatch[1].trim(),
  };
}

async function main() {
  const files: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      files.push(`${PROMPTS_DIR}${entry.name}`);
    }
  }
  files.sort();

  const isLocalKey = SERVICE_ROLE_KEY === LOCAL_DEV_SERVICE_ROLE_KEY;
  console.log(`Found ${files.length} prompt file(s) in ${PROMPTS_DIR}`);
  console.log(`URL: ${SUPABASE_URL}  (key: ${isLocalKey ? "local-dev default" : "from env"})\n`);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let synced = 0;
  let errors = 0;

  for (const path of files) {
    const filename = path.split("/").pop()!;
    try {
      const content = await Deno.readTextFile(path);
      const p = parsePromptFile(content, filename);

      // Step 1: deactivate any prior active row(s) for this prompt_key.
      const { error: deactErr } = await supabase
        .from("prompts")
        .update({ is_active: false })
        .eq("prompt_key", p.prompt_key);
      if (deactErr) throw new Error(`deactivate failed: ${deactErr.message}`);

      // Step 2: upsert this version. is_active comes from the file (default true).
      const { error: upsertErr } = await supabase
        .from("prompts")
        .upsert(
          {
            prompt_key: p.prompt_key,
            version: p.version,
            model: p.model,
            system_prompt: p.system_prompt,
            user_prompt_template: p.user_prompt_template,
            max_tokens: p.max_tokens,
            notes: p.notes,
            is_active: p.is_active,
          },
          { onConflict: "prompt_key,version" },
        );
      if (upsertErr) throw new Error(`upsert failed: ${upsertErr.message}`);

      const sysDesc = p.system_prompt ? `sys=${p.system_prompt.length}` : "sys=null";
      console.log(
        `  ok  ${p.prompt_key}@${p.version}  ${p.model}  ${sysDesc}  user=${p.user_prompt_template.length}`,
      );
      synced++;
    } catch (err) {
      console.error(`  err ${filename}: ${(err as Error).message}`);
      errors++;
    }
  }

  console.log(`\nSynced ${synced}/${files.length}. Errors: ${errors}`);
  if (errors > 0) Deno.exit(1);
}

await main();
