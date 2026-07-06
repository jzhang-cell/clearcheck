import mammoth from "npm:mammoth@^1.8";
import { Buffer } from "node:buffer";

export async function extractDocText(
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  if (ext === "txt" || ext === "md") {
    return new TextDecoder().decode(bytes);
  }

  if (ext === "docx") {
    // Pass a Node Buffer — mammoth's option-detection through Deno's Node-compat
    // layer doesn't reliably recognize ArrayBuffer keys (yields "Could not find
    // file in options"), but Buffer.from(Uint8Array) is recognized.
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value;
  }

  if (ext === "doc") {
    throw new Error(
      "Legacy .doc format is not supported. Please convert to .docx.",
    );
  }

  throw new Error(`Cannot extract text from filename: ${filename}`);
}
