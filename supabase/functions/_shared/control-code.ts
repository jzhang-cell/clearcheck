// Control codes can arrive from Airtable imports with invisible Unicode format
// characters (for example a trailing U+FEFF byte-order mark). Those characters
// are not visible to an auditor but break exact Drive-folder comparisons.
const INVISIBLE_FORMAT_CHARACTERS =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

export function normalizeControlCode(value: string): string {
  return value.normalize("NFKC").replace(INVISIBLE_FORMAT_CHARACTERS, "").trim();
}

export function controlCodesEqual(left: string, right: string): boolean {
  return normalizeControlCode(left) === normalizeControlCode(right);
}
