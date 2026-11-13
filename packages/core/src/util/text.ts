/**
 * Text helpers for consumers that print or read untrusted text, such as the CLI
 * showing Duet messages in a terminal or reading a message body from stdin.
 */

/**
 * C0 controls except tab (0x09) and line feed (0x0A), DEL (0x7F) and the C1
 * range (0x80-0x9F). Carriage return is included: a lone CR can overwrite the
 * start of a line in a terminal.
 */
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/**
 * Remove control characters from text before it is printed to a terminal.
 *
 * API-derived text (message bodies, display names, task titles, suggestion
 * fields) can carry ESC or C1 sequences that retitle the terminal, hide text or
 * write the clipboard (OSC 52). Dropping the control bytes leaves any sequence
 * as inert printable text. Newline and tab are kept so multi-line text still
 * reads naturally. Not for JSON output, whose encoder already escapes controls.
 *
 * @param text - Text to print.
 * @returns The text with C0 controls (except `\n` and `\t`), DEL and C1
 * controls removed.
 */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, "");
}

/**
 * Read a byte stream to the end as UTF-8 text, refusing input larger than a cap.
 *
 * Reading stops, and the stream is released, as soon as the total passes
 * `maxBytes`, so an unbounded pipe cannot exhaust memory. Decoding happens once
 * at the end, so a multi-byte character split across chunks survives, and a
 * leading byte-order mark is kept (the bytes are passed through, not cleaned).
 *
 * @param source - Chunks of the stream, for example `process.stdin`. String
 * chunks are taken as UTF-8.
 * @param maxBytes - Largest accepted input in bytes; exactly this many is fine.
 * @returns The whole input as text.
 * @throws {@link Error} `input is more than <maxBytes> bytes` once the input
 * passes the cap.
 */
export async function readTextCapped(
  source: AsyncIterable<Uint8Array | string>,
  maxBytes: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new Error(`input is more than ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
