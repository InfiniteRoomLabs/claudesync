/** Delimiter line separating entries in `edits.md`. A control entry must not contain a line equal to this. */
const DELIMITER = "---";

/**
 * Canonicalize text for stable hashing and on-disk form: strip a leading UTF-8
 * BOM, convert CRLF and lone CR to LF, and collapse trailing blank lines to
 * exactly one terminal newline. Empty input stays "".
 *
 * @param text - Raw text.
 * @returns The canonical form.
 */
export function canonicalize(text: string): string {
  const noBom = text.replace(/^\uFEFF/, "");
  const lf = noBom.replace(/\r\n?/g, "\n");
  const trimmed = lf.replace(/\n+$/, "");
  return trimmed === "" ? "" : trimmed + "\n";
}

/**
 * Render the `controls` array to `edits.md`. Each entry is trimmed and the
 * entries are joined by a lone `---` delimiter line. An empty array renders to
 * "". Inverse of {@link parseEdits} for entries containing no `---` line.
 *
 * @param controls - Ordered edit instructions.
 * @returns The file text.
 */
export function serializeEdits(controls: string[]): string {
  const blocks = controls.map((c) => c.trim()).filter((c) => c !== "");
  if (blocks.length === 0) return "";
  return blocks.join(`\n${DELIMITER}\n`) + "\n";
}

/**
 * Parse `edits.md` back into the ordered `controls` array: split on lines equal
 * to `---`, trim each block, and drop empties. Inverse of {@link serializeEdits}.
 *
 * @param fileText - The `edits.md` contents.
 * @returns The ordered edit instructions.
 */
export function parseEdits(fileText: string): string[] {
  return fileText
    .split(/^---$/m)
    .map((b) => b.trim())
    .filter((b) => b !== "");
}
