// Supabase Storage rejects object-key segments containing characters such as
// square brackets. Keep the human-facing filename unchanged in evidence_files,
// but use a deterministic, collision-resistant safe name for the object path.

function shortFilenameHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function storageObjectFilename(filename: string): string {
  const original = filename.trim();
  const leaf = original.split(/[\\/]/).pop() || "evidence-file";
  const dot = leaf.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < leaf.length - 1;
  const rawStem = hasExtension ? leaf.slice(0, dot) : leaf;
  const rawExtension = hasExtension ? leaf.slice(dot + 1) : "";

  const safeStem = rawStem
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 160) || "evidence-file";
  const safeExtension = rawExtension
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 16);

  const alreadySafe = leaf === `${safeStem}${safeExtension ? `.${safeExtension}` : ""}`;
  if (alreadySafe && leaf.length <= 180) return leaf;

  const suffix = shortFilenameHash(leaf);
  return `${safeStem}-${suffix}${safeExtension ? `.${safeExtension}` : ""}`;
}
