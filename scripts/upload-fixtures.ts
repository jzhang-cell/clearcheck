// Uploads files from a local directory to the Supabase Storage 'evidence' bucket.
// Skips dotfiles (.DS_Store etc). Uses upsert so reruns are idempotent.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... deno run \
//     --allow-read --allow-env --allow-net \
//     scripts/upload-fixtures.ts <local-dir> <storage-prefix>
//
// Example:
//   ... scripts/upload-fixtures.ts \
//     "supabase/fixtures/real/CC.01.02-Management-meeting" \
//     "ecton/CC.01.02"

import { createClient } from "npm:@supabase/supabase-js@^2";

const [localDir, storagePrefix] = Deno.args;
if (!localDir || !storagePrefix) {
  console.error("Usage: scripts/upload-fixtures.ts <local-dir> <storage-prefix>");
  Deno.exit(1);
}

const url = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!key) {
  console.error("SUPABASE_SERVICE_ROLE_KEY env required");
  Deno.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const entries: string[] = [];
for await (const entry of Deno.readDir(localDir)) {
  if (entry.isFile && !entry.name.startsWith(".")) entries.push(entry.name);
}
entries.sort();

console.log(`Uploading ${entries.length} files: ${localDir} → evidence/${storagePrefix}/`);

let ok = 0;
let fail = 0;

for (const name of entries) {
  const localPath = `${localDir}/${name}`;
  const storagePath = `${storagePrefix}/${name}`;
  const bytes = await Deno.readFile(localPath);

  const { error } = await supabase.storage
    .from("evidence")
    .upload(storagePath, bytes, { upsert: true });

  if (error) {
    console.error(`  err  ${name}: ${error.message}`);
    fail++;
  } else {
    console.log(`  ok   ${name}  (${bytes.length} bytes)`);
    ok++;
  }
}

console.log(`\nUploaded ${ok}/${entries.length}, failed ${fail}`);
Deno.exit(fail > 0 ? 1 : 0);
