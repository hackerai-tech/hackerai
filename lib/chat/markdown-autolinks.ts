/**
 * GFM ends a bare URL before trailing `_` and `~`, as it does for sentence
 * punctuation, so `https://example.com/name_` would link to `.../name`. In
 * assistant output those characters usually end a path, query or fragment.
 *
 * Two steps keep them:
 * - After parsing, a `_`/`~` run left as plain text directly after a bare
 *   URL's path is moved back into the link. Runs the parser used as emphasis
 *   or strikethrough delimiters are not plain text, so formatting wins.
 * - Streaming repair (remend) runs on the raw text before parsing and would
 *   count that run as an unclosed delimiter and append a stray closer. Its
 *   handler hooks hide URL delimiters from the repair heuristics, then
 *   restore them before parsing.
 */

const BARE_URL_PREFIX = /^(?:https?:\/\/|www\.)/i;
const SUFFIX_RUN = /^[_~]+/;

/** A host alone cannot end in `_` or `~`; only a path, query or fragment can. */
function hasPathAfterHost(url: string): boolean {
  const prefix = BARE_URL_PREFIX.exec(url);
  return prefix !== null && /[/?#]/.test(url.slice(prefix[0].length));
}

interface MarkdownPoint {
  offset?: number;
  column?: number;
}

interface MarkdownNode {
  type: string;
  url?: unknown;
  value?: unknown;
  children?: MarkdownNode[];
  position?: { start?: MarkdownPoint; end?: MarkdownPoint };
}

function advance(point: MarkdownPoint | undefined, by: number): void {
  if (typeof point?.offset === "number") point.offset += by;
  if (typeof point?.column === "number") point.column += by;
}

function attachUrlSuffixes(parent: MarkdownNode, source: string): void {
  const children = parent.children;
  if (!Array.isArray(children)) return;
  for (let index = 0; index < children.length; index++) {
    const link = children[index];
    attachUrlSuffixes(link, source);
    const next = children[index + 1];
    const label = link.children?.length === 1 ? link.children[0] : undefined;
    const start = link.position?.start?.offset;
    const end = link.position?.end?.offset;
    if (
      link.type !== "link" ||
      typeof link.url !== "string" ||
      label?.type !== "text" ||
      typeof label.value !== "string" ||
      next?.type !== "text" ||
      typeof next.value !== "string" ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      // Only a bare URL is its own source text; explicit, angle and
      // reference links include brackets.
      source.slice(start, end) !== label.value ||
      !hasPathAfterHost(label.value)
    ) {
      continue;
    }
    const suffix = SUFFIX_RUN.exec(next.value)?.[0];
    if (
      !suffix ||
      next.position?.start?.offset !== end ||
      // Escaped or entity-encoded characters are not part of the URL.
      source.slice(end, end + suffix.length) !== suffix
    ) {
      continue;
    }
    link.url += suffix;
    label.value += suffix;
    next.value = next.value.slice(suffix.length);
    advance(link.position?.end, suffix.length);
    advance(label.position?.end, suffix.length);
    advance(next.position?.start, suffix.length);
    if (next.value === "") children.splice(index + 1, 1);
  }
}

/** Remark plugin: keep literal `_`/`~` suffixes in bare URL links. */
export function remarkBareUrlSuffixes() {
  return (tree: MarkdownNode, file: { value?: unknown }) =>
    attachUrlSuffixes(tree, String(file.value ?? ""));
}

// Unicode noncharacters U+FDD0/U+FDD1 are reserved for process-internal use.
const UNDERSCORE_MASK = String.fromCharCode(0xfdd0);
const TILDE_MASK = String.fromCharCode(0xfdd1);
const MASKS: Record<string, string> = { _: UNDERSCORE_MASK, "~": TILDE_MASK };
const UNMASK: Record<string, string> = {
  [UNDERSCORE_MASK]: "_",
  [TILDE_MASK]: "~",
};
const MASKED = new RegExp(`[${UNDERSCORE_MASK}${TILDE_MASK}]`, "g");

const URL_START = /https?:\/\/|www\./iy;
const WWW_PREVIOUS = /[\s(*_[\]~]/;
const ASCII_LETTER = /[A-Za-z]/;
const TRAILING_PUNCTUATION = /[!"'*,.:?\]_~]/;
const WORD = /[\p{L}\p{N}]/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** End of a GFM bare URL candidate starting at `start`, or -1. */
function bareUrlEnd(text: string, start: number): number {
  URL_START.lastIndex = start;
  const prefix = URL_START.exec(text)?.[0];
  if (!prefix) return -1;
  const previous = text[start - 1];
  if (
    previous !== undefined &&
    (prefix.length === 4
      ? !WWW_PREVIOUS.test(previous)
      : ASCII_LETTER.test(previous))
  ) {
    return -1;
  }
  let end = start + prefix.length;
  while (end < text.length && !/\s/.test(text[end]) && text[end] !== "<") {
    end++;
  }
  return end;
}

/** Drop the trailing punctuation GFM leaves outside the link. */
function linkedEnd(text: string, start: number, end: number): number {
  let unbalanced =
    text.slice(start, end).split(")").length -
    text.slice(start, end).split("(").length;
  while (end > start) {
    const character = text[end - 1];
    if (character === ")" && unbalanced > 0) {
      unbalanced--;
    } else if (character === ";") {
      // `&name;` trails as a whole. Scan only the letters before this `;`:
      // without an `&` the next character is a letter, which stops the trim,
      // so long punctuation runs stay linear.
      let name = end - 1;
      while (name > start && ASCII_LETTER.test(text[name - 1])) name--;
      if (name < end - 1 && name > start && text[name - 1] === "&") {
        end = name - 1;
        continue;
      }
    } else if (!TRAILING_PUNCTUATION.test(character)) {
      break;
    }
    end--;
  }
  return end;
}

function runEnd(text: string, start: number): number {
  let end = start + 1;
  while (text[end] === text[start]) end++;
  return end;
}

/**
 * Replace `_`/`~` inside bare URLs, and the suffix run attached to a URL path,
 * with placeholders. With `keepClosers`, a suffix run stays visible when an
 * earlier same-character delimiter is still open, because it closes that
 * formatting instead of ending the URL.
 */
function maskBareUrlDelimiters(text: string, keepClosers: boolean): string {
  if (text.search(MASKED) !== -1) return text;
  const open: Record<string, boolean> = { _: false, "~": false };
  const unclosedCodeRuns = new Set<number>();
  let output = "";
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += ESCAPABLE.test(text[index + 1] ?? "") ? 2 : 1;
    } else if (character === "`") {
      const end = runEnd(text, index);
      const length = end - index;
      let close = unclosedCodeRuns.has(length) ? -1 : text.indexOf("`", end);
      while (close !== -1 && runEnd(text, close) - close !== length) {
        close = text.indexOf("`", runEnd(text, close));
      }
      if (close === -1) unclosedCodeRuns.add(length);
      index = close === -1 ? end : close + length;
    } else if (character === "]" && text[index + 1] === "(") {
      // Explicit link destinations follow link rules, not bare URL rules.
      const close = text.indexOf(")", index + 2);
      index = close === -1 ? text.length : close + 1;
    } else if (character === "_" || character === "~") {
      const end = runEnd(text, index);
      // Underscores inside a word never open or close emphasis.
      if (
        character === "~" ||
        !(WORD.test(text[index - 1] ?? "") && WORD.test(text[end] ?? ""))
      ) {
        open[character] = !open[character];
      }
      index = end;
    } else {
      const end = /[hw]/i.test(character) ? bareUrlEnd(text, index) : -1;
      if (end === -1) {
        index++;
        continue;
      }
      const linked = linkedEnd(text, index, end);
      output +=
        text.slice(copied, index) +
        text.slice(index, linked).replace(/[_~]/g, (found) => MASKS[found]);
      const hasPath = hasPathAfterHost(text.slice(index, linked));
      index = linked;
      // The suffix run: `_` and `~` sub-runs right after the linked path.
      while (hasPath && (text[index] === "_" || text[index] === "~")) {
        const delimiter = text[index];
        const subRunEnd = runEnd(text, index);
        const subRun = text.slice(index, subRunEnd);
        if (keepClosers && open[delimiter]) {
          open[delimiter] = false;
          output += subRun;
        } else {
          output += MASKS[delimiter].repeat(subRun.length);
        }
        index = subRunEnd;
      }
      copied = index;
    }
  }
  return output + text.slice(copied);
}

function restoreBareUrlDelimiters(text: string): string {
  return text.replace(MASKED, (found) => UNMASK[found]);
}

/** Structurally matches remend's custom handler, which Streamdown accepts. */
export interface MarkdownRepairHandler {
  name: string;
  priority: number;
  handle: (text: string) => string;
}

/** Mask bare URL delimiters for the remend handlers between two priorities. */
function hideBareUrlDelimiters(
  name: string,
  from: number,
  until: number,
  keepClosers: boolean,
): MarkdownRepairHandler[] {
  // remend runs its handlers synchronously in priority order, so the restore
  // step always follows the mask step from the same call.
  let masked = false;
  return [
    {
      name: `${name}-hide`,
      priority: from,
      handle: (text) => {
        const result = maskBareUrlDelimiters(text, keepClosers);
        masked = result !== text;
        return result;
      },
    },
    {
      name: `${name}-restore`,
      priority: until,
      handle: (text) => {
        if (!masked) return text;
        masked = false;
        return restoreBareUrlDelimiters(text);
      },
    },
  ];
}

/**
 * remend handlers for Streamdown's `remend.handlers`. Built-in priorities:
 * single-tilde escaping 0, link completion 20 (may return early, so no mask
 * may span it), emphasis 30-42, strikethrough 60, math 70-75.
 */
export const bareUrlRepairHandlers: readonly MarkdownRepairHandler[] = [
  // Single-tilde escaping would turn `name~_` into `name\~_`, putting a
  // backslash into the URL.
  ...hideBareUrlDelimiters("bare-url-tilde-escape", -1, 1, false),
  // Emphasis and strikethrough completion would close a URL suffix run.
  ...hideBareUrlDelimiters("bare-url-delimiters", 21, 1000, true),
];
