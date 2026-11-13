import { describe, expect, it } from "vitest";
import { readTextCapped, stripControlChars } from "@core/util/text.js";

/** U+00E9, a two-byte UTF-8 character, built from its code point to keep this file ASCII. */
const E_ACUTE = String.fromCodePoint(0xe9);
/** U+2603, a three-byte UTF-8 character. */
const SNOWMAN = String.fromCodePoint(0x2603);
/** U+FEFF, the byte-order mark. */
const BOM = String.fromCodePoint(0xfeff);

/** Yield each part as a separate chunk, the way a readable stream does. */
async function* chunks(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array | string> {
  for (const part of parts) {
    yield part;
  }
}

describe("stripControlChars", () => {
  it("removes terminal escapes (C0 and C1) but keeps newline and tab", () => {
    // OSC 52 (clipboard write) and an 8-bit CSI lose their control bytes.
    expect(stripControlChars("a\u001b]52;c;ZXZpbA==\u0007b")).toBe("a]52;c;ZXZpbA==b");
    expect(stripControlChars("x\u009b31my")).toBe("x31my");
    expect(stripControlChars("tab\there\nnext\r\n")).toBe("tab\there\nnext\n");
    expect(stripControlChars("\u0000\u0008\u000b\u000c\u001f\u007f\u0080\u009f")).toBe("");
  });

  it("leaves printable text, including non-ASCII, untouched", () => {
    const text = `Caf${E_ACUTE} ${SNOWMAN} Review the quarterly notes`;
    expect(stripControlChars(text)).toBe(text);
  });
});

describe("readTextCapped", () => {
  it("joins the chunks as UTF-8, even a character split across chunks", async () => {
    const snowman = Buffer.from(SNOWMAN, "utf-8");
    expect(
      await readTextCapped(chunks(Buffer.from("a"), snowman.subarray(0, 1), snowman.subarray(1), "b"), 100)
    ).toBe(`a${SNOWMAN}b`);
  });

  it("keeps a leading byte-order mark", async () => {
    expect(await readTextCapped(chunks(Buffer.from(`${BOM}hi`, "utf-8")), 100)).toBe(`${BOM}hi`);
  });

  it("accepts input of exactly the cap", async () => {
    expect(await readTextCapped(chunks("x".repeat(60), "y".repeat(40)), 100)).toHaveLength(100);
  });

  it("throws once the input passes the cap", async () => {
    await expect(readTextCapped(chunks("x".repeat(60), "y".repeat(41)), 100)).rejects.toThrow(
      /more than 100 bytes/
    );
  });
});
