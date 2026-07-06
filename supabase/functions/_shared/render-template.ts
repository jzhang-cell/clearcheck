// Throws on missing placeholders so we fail fast rather than silently
// substituting empty strings into a Claude prompt.
export function renderTemplate(
  template: string,
  ctx: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in ctx)) {
      throw new Error(`Template missing value for placeholder '{{${key}}}'`);
    }
    return ctx[key];
  });
}
