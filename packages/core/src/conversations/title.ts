import type { ChatMessage, Conversation } from "../models/types.js";
import { buildMessageTree, getLinearBranch } from "../tree/message-tree.js";

/**
 * Maximum length of a derived title, in grapheme clusters (user-perceived
 * characters) rather than UTF-16 code units. Enforced by
 * {@link truncateToGraphemes} via `Intl.Segmenter`, so multi-code-unit
 * clusters (emoji, combining marks) are never split.
 */
export const MAX_TITLE_GRAPHEMES = 60;

/**
 * How many graphemes into the truncation window a word-boundary cut must
 * land at or past to be preferred over a hard cut. Keeps a truncated title
 * from collapsing to just a few characters when an early space happens to
 * exist (e.g. "A " at grapheme 1) -- below this floor {@link truncateToGraphemes}
 * falls back to a hard cut at exactly {@link MAX_TITLE_GRAPHEMES}.
 */
const MIN_WORD_BOUNDARY_GRAPHEME_INDEX = 20;

/**
 * Ceiling on how much of a message's raw text is considered at all, in UTF-16
 * code units. Applied FIRST, before any sanitization regex runs, so that a
 * pathological multi-kilobyte opener (e.g. a fenced code block whose closing
 * marker sits far beyond this window) can never make sanitization behave
 * differently than it would for a short message -- the fence-stripping pass
 * only ever sees what's inside this window and treats a closer beyond it as
 * absent (i.e. the fence reads as unterminated). This is a deliberately
 * simple code-unit slice, not grapheme-safe; grapheme safety is enforced only
 * at the final title-length truncation in {@link truncateToGraphemes}, which
 * operates on a much smaller, already-sanitized string.
 */
const MAX_INPUT_CODE_UNITS = 1024;

/**
 * Matches a fenced code block delimited by triple backticks, including its
 * language tag and body. Two alternatives, tried left to right:
 *
 * 1. A closed fence: opening ``` through the next ``` (non-greedy, so
 *    adjacent fences don't merge into one match).
 * 2. An unterminated fence: opening ``` with no closer anywhere in the
 *    (already 1024-char-truncated) input, matching through end of string.
 *
 * Both alternatives are replaced with "" -- fenced code never contributes to
 * a title, and an unterminated opener drops everything from the marker on,
 * per the derivation spec.
 */
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```|```[\s\S]*$/g;

/** Matches inline code spans (single backticks). Replaced with the captured inner text -- the backticks are dropped but the code content is kept as plain text. */
const INLINE_BACKTICK_RE = /`([^`]*)`/g;

/** Matches a markdown link `[text](url)`. Replaced with the captured link text -- the URL is dropped entirely. */
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;

/** Matches an ATX heading marker (`#` through `######`, up to 3 leading spaces, trailing whitespace) at the start of a line. Replaced with "" -- only the marker is stripped, any heading text is kept. */
const MARKDOWN_HEADING_RE = /^ {0,3}#{1,6}(?:\s+|$)/gm;

/** Matches bold emphasis (`**text**` or `__text__`), non-greedy. Replaced with the captured inner text. Runs before {@link MARKDOWN_ITALIC_RE} so single-marker italics aren't confused by the doubled markers. */
const MARKDOWN_BOLD_RE = /(\*\*|__)(.*?)\1/g;

/** Matches italic emphasis (`*text*` or `_text_`), non-greedy. Replaced with the captured inner text. Runs after {@link MARKDOWN_BOLD_RE} has already consumed doubled markers. */
const MARKDOWN_ITALIC_RE = /(\*|_)(.*?)\1/g;

/**
 * Matches ANSI/OSC terminal escape sequences, as three alternatives tried
 * left to right:
 *
 * 1. OSC (Operating System Command): ESC `]` ... terminated by BEL or ST
 *    (`ESC \`). The terminator is optional so a truncated/malformed OSC at
 *    the end of the input is still consumed rather than leaking a stray ESC.
 * 2. CSI (Control Sequence Introducer): ESC `[`, parameter bytes, optional
 *    intermediate bytes, one final byte -- covers cursor movement, SGR color
 *    codes, etc.
 * 3. Fe escape sequences: ESC followed by a single byte in the `@`-`Z` /
 *    `\`-`_` range -- covers the short two-byte forms (e.g. `ESC c` reset).
 *
 * All three are replaced with "".
 */
const ANSI_OSC_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\\]^_]/g;

/**
 * Matches C0 control characters (0x00-0x1F, 0x7F) EXCEPT tab, line feed, and
 * carriage return, which are left for {@link WHITESPACE_RUN_RE} to fold into
 * a single space. Runs after {@link ANSI_OSC_RE} so any ESC (0x1B) that is
 * part of a recognized escape sequence has already been consumed; a stray,
 * unrecognized ESC is still removed here.
 */
const C0_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Matches C1 control characters (0x80-0x9F). Replaced with "". */
const C1_CONTROL_RE = /[\x80-\x9F]/g;

/**
 * Matches explicit bidirectional-formatting control characters: the
 * embedding/override pair U+202A-U+202E (LRE, RLE, PDF, LRO, RLO) and the
 * isolate set U+2066-U+2069 (LRI, RLI, FSI, PDI). These render invisibly but
 * can reorder surrounding text, so they're stripped while the RTL/LTR text
 * they wrapped is kept as-is.
 */
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;

/** Matches any run of one or more whitespace characters. Replaced with a single space to collapse newlines, tabs, and repeated spaces from pasted/logged text. */
const WHITESPACE_RUN_RE = /\s+/g;

/**
 * Selects the message text a title should be derived from: the earliest
 * human message on the conversation's active branch.
 *
 * @remarks
 * "Active branch" means the root-to-leaf path ending at
 * `current_leaf_message_uuid`, walked via {@link buildMessageTree} and
 * {@link getLinearBranch}. When that uuid is missing (null/undefined/empty)
 * or does not resolve to any message in the tree, this falls back to a
 * simpler, tree-agnostic rule: the first human message in `chat_messages`
 * array order. This fallback intentionally does NOT kick in just because a
 * validly-resolved active branch happens to contain no human message (e.g.
 * an assistant-only conversation) -- in that case there is correctly no
 * title to derive, not a reason to go looking on a different branch.
 *
 * @param conversation - The conversation's messages and active-branch pointer.
 * @returns The earliest human {@link ChatMessage} on the resolved branch, or
 *   `undefined` when none exists.
 */
function selectActiveBranchHumanMessage(
  conversation: Pick<Conversation, "chat_messages" | "current_leaf_message_uuid">,
): ChatMessage | undefined {
  const { chat_messages: messages, current_leaf_message_uuid: leafUuid } = conversation;

  if (leafUuid) {
    const tree = buildMessageTree(messages);
    const branch = getLinearBranch(tree, leafUuid);
    if (branch.length > 0) {
      return branch.find((m) => m.sender === "human");
    }
  }

  // Leaf uuid missing or unresolvable in the tree -- fall back to array order.
  return messages.find((m) => m.sender === "human");
}

/**
 * Runs every sanitization pass over a (already length-capped) message text,
 * in the fixed order required for correctness: fenced code and inline code
 * must be stripped before markdown emphasis/heading/link syntax can be
 * evaluated on what remains; terminal escapes and control characters are
 * removed last, before the final whitespace collapse so any control chars
 * they left behind still get folded away.
 *
 * @param text - Raw message text, already capped to {@link MAX_INPUT_CODE_UNITS}.
 * @returns The sanitized text, collapsed to single spaces and trimmed. May be "".
 */
function sanitize(text: string): string {
  let result = text;
  result = result.replace(FENCED_CODE_BLOCK_RE, "");
  result = result.replace(INLINE_BACKTICK_RE, "$1");
  result = result.replace(MARKDOWN_LINK_RE, "$1");
  result = result.replace(MARKDOWN_HEADING_RE, "");
  result = result.replace(MARKDOWN_BOLD_RE, "$2");
  result = result.replace(MARKDOWN_ITALIC_RE, "$2");
  result = result.replace(ANSI_OSC_RE, "");
  result = result.replace(C0_CONTROL_RE, "");
  result = result.replace(C1_CONTROL_RE, "");
  result = result.replace(BIDI_CONTROL_RE, "");
  result = result.replace(WHITESPACE_RUN_RE, " ");
  return result.trim();
}

/**
 * Truncates already-sanitized, NFC-normalized text to at most
 * {@link MAX_TITLE_GRAPHEMES} grapheme clusters, using `Intl.Segmenter` so a
 * multi-code-unit cluster (emoji ZWJ sequence, combining mark, surrogate
 * pair) is never split across the cut.
 *
 * @remarks
 * When the text already fits, it is returned unchanged. Otherwise, the last
 * grapheme that is a literal space, at or past
 * {@link MIN_WORD_BOUNDARY_GRAPHEME_INDEX}, is preferred as the cut point
 * (the space itself is dropped, so the result never ends on it) -- this
 * avoids severing a word mid-way. When no such space exists within the
 * window, the text is hard-cut at exactly {@link MAX_TITLE_GRAPHEMES}
 * graphemes. Either way, a final trailing-space trim guards against an edge
 * case landing exactly on a space.
 *
 * @param text - Sanitized, NFC-normalized, non-empty text.
 * @returns The text, truncated to the grapheme cap.
 */
function truncateToGraphemes(text: string): string {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);

  if (graphemes.length <= MAX_TITLE_GRAPHEMES) {
    return text;
  }

  const window = graphemes.slice(0, MAX_TITLE_GRAPHEMES);

  let cutAt = window.length; // default: hard cut, keep the whole window
  for (let i = window.length - 1; i >= MIN_WORD_BOUNDARY_GRAPHEME_INDEX; i--) {
    if (window[i] === " ") {
      cutAt = i; // exclude the space itself
      break;
    }
  }

  return window.slice(0, cutAt).join("").replace(/ +$/, "");
}

/**
 * Derives a display title from a hydrated conversation's opening human
 * message, or `null` when no usable text exists.
 *
 * @remarks
 * Pure and deterministic: the same conversation always produces the same
 * title (or `null`), and this function never invents a title out of nothing
 * -- when the source text is missing, whitespace-only, markdown-only, or
 * otherwise sanitizes to nothing, the title stays unresolved rather than
 * falling back to a placeholder. Callers that need a non-null fallback (e.g.
 * a slug or "Untitled conversation" label) apply that separately.
 *
 * The derivation, in order:
 *
 * 1. Select the earliest human message on the active branch (see
 *    {@link selectActiveBranchHumanMessage}). No human message anywhere ->
 *    `null`.
 * 2. Take at most the first {@link MAX_INPUT_CODE_UNITS} UTF-16 code units of
 *    that message's text, before any other processing.
 * 3. Sanitize (see {@link sanitize}): strip fenced code, inline code
 *    backticks, markdown emphasis/heading/link syntax, ANSI/OSC escapes, and
 *    C0/C1/bidi control characters; collapse whitespace; trim.
 * 4. Unicode NFC-normalize the result.
 * 5. If the normalized result is empty -> `null`.
 * 6. Truncate to {@link MAX_TITLE_GRAPHEMES} grapheme clusters (see
 *    {@link truncateToGraphemes}).
 *
 * @param conversation - A hydrated conversation's messages and active-branch
 *   pointer; typically a {@link Conversation} but any object with the same
 *   `chat_messages` and `current_leaf_message_uuid` shape works.
 * @returns The derived title, or `null` when no title can be derived.
 */
export function deriveConversationTitle(
  conversation: Pick<Conversation, "chat_messages" | "current_leaf_message_uuid">,
): string | null {
  const humanMessage = selectActiveBranchHumanMessage(conversation);
  if (!humanMessage) {
    return null;
  }

  const capped = humanMessage.text.slice(0, MAX_INPUT_CODE_UNITS);
  const sanitized = sanitize(capped);
  const normalized = sanitized.normalize("NFC");

  if (normalized.length === 0) {
    return null;
  }

  return truncateToGraphemes(normalized);
}
