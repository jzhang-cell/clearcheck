// Convert an .xlsx/.xls workbook to CSV text so the existing CSV extractor can
// read it. Spreadsheets aren't a natively supported evidence type; this normalizes
// them to CSV (all sheets concatenated, each labelled when there's more than one).
// SheetJS is pure JS and runs in Deno edge functions via the npm: specifier.
import * as XLSX from "npm:xlsx@0.18.5";

export function xlsxToCsv(bytes: Uint8Array): string {
  const wb = XLSX.read(bytes, { type: "array" });
  if (!wb.SheetNames.length) return "";
  return wb.SheetNames
    .map((name) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name] as XLSX.WorkSheet);
      return wb.SheetNames.length > 1 ? `# Sheet: ${name}\n${csv}` : csv;
    })
    .join("\n\n")
    .trim();
}
