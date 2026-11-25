/**
 * Gives each top-level Markdown block the direction of its own prose, so an
 * Arabic or Hebrew paragraph reads right to left while English blocks in the
 * same reply stay left to right. It runs after the sanitize and harden plugins
 * and only adds literal `dir` attributes and `<bdi>` wrappers; text values are
 * never changed and no control characters are inserted.
 *
 * Direction is decided by words rather than characters, so one long English
 * token such as a model ID or path cannot outweigh a short Arabic sentence.
 * Code is left out of the count because it always renders left to right.
 */

export type TextDirection = "ltr" | "rtl";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Letters from right-to-left scripts; digits and punctuation stay neutral.
const RTL_LETTER =
  /(?=\p{L})[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const ANY_LETTER = /\p{L}/u;
// Terminal punctuation (including the Arabic question mark and full stop)
// ends a sentence only when whitespace follows, so dots inside paths,
// versions and file names do not split one.
const SENTENCE_END = /[.!?؟۔]\s+/gu;

// Line breaks around these keep words from neighbouring blocks apart and make
// each list item or table cell its own sentence.
const BLOCK_TAGS = new Set([
  "blockquote",
  "br",
  "dd",
  "div",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

function wordDirection(word: string): TextDirection | null {
  if (RTL_LETTER.test(word)) return "rtl";
  return ANY_LETTER.test(word) ? "ltr" : null;
}

/**
 * Majority of sentences, then of words, then the first directional word.
 * Returns null when the text has no letters, leaving the inherited direction.
 */
export function detectTextDirection(text: string): TextDirection | null {
  let rtlSentences = 0;
  let ltrSentences = 0;
  let rtlWords = 0;
  let ltrWords = 0;
  let firstDirection: TextDirection | null = null;

  for (const sentence of text.replace(SENTENCE_END, "\n").split("\n")) {
    let rtl = 0;
    let ltr = 0;
    for (const word of sentence.split(/\s+/)) {
      const direction = wordDirection(word);
      if (!direction) continue;
      firstDirection ??= direction;
      if (direction === "rtl") rtl++;
      else ltr++;
    }
    rtlWords += rtl;
    ltrWords += ltr;
    if (rtl > ltr) rtlSentences++;
    else if (ltr > rtl) ltrSentences++;
  }

  if (rtlSentences !== ltrSentences) {
    return rtlSentences > ltrSentences ? "rtl" : "ltr";
  }
  if (rtlWords !== ltrWords) return rtlWords > ltrWords ? "rtl" : "ltr";
  return firstDirection;
}

function proseText(block: HastNode): string {
  const parts: string[] = [];
  const visit = (node: HastNode): void => {
    if (node.type === "text") {
      // A newline inside text is a Markdown soft wrap within one paragraph,
      // not a sentence break; block boundaries below add their own.
      parts.push((node.value ?? "").replace(/\n/g, " "));
      return;
    }
    if (node.type !== "element") return;
    if (node.tagName === "code" || node.tagName === "pre") {
      parts.push(" ");
      return;
    }
    const isBlock = BLOCK_TAGS.has(node.tagName ?? "");
    if (isBlock) parts.push("\n");
    node.children?.forEach(visit);
    if (isBlock) parts.push("\n");
  };
  visit(block);
  return parts.join("");
}

// A bare rooted local path (`/`, `~/`, `./`, `../`) that starts the text or
// follows whitespace or an opening bracket or quote. Requiring that boundary
// skips slashes inside URLs, dates and words such as "and/or". Brackets,
// quotes and Arabic punctuation end the path so they stay outside it.
const BARE_PATH =
  /(^|[\s([{"'«“‘])((?:~|\.{1,2})?\/[^\s<>"'()[\]{}«»“”‘’،؛؟]*)/gu;
const PATH_TRAILING_PUNCTUATION = new Set([".", ",", ":", ";", "!", "?"]);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// A reverse scan rather than /[.,:;!?]+$/: that regex retries from every
// punctuation character, so a long run followed by a letter is quadratic.
function trimTrailingPunctuation(path: string): string {
  let end = path.length;
  while (end > 0 && PATH_TRAILING_PUNCTUATION.has(path[end - 1])) end--;
  return path.slice(0, end);
}

// Links, code and existing isolates already keep their own direction.
const ISOLATED_TAGS = new Set(["a", "bdi", "code", "pre"]);

/**
 * Split text so each bare path sits in `<bdi dir="ltr">`. Without it a
 * right-to-left paragraph moves the leading slash to the other end of the
 * path. The pieces concatenate to exactly the original text.
 */
function isolateBarePathsInText(text: string): HastNode[] | null {
  let pieces: HastNode[] | null = null;
  let cursor = 0;
  for (const match of text.matchAll(BARE_PATH)) {
    const path = trimTrailingPunctuation(match[2]);
    // Skip a lone slash and Arabic words written after one ("نعم /لا"):
    // those read correctly in the surrounding right-to-left order.
    if (!LETTER_OR_DIGIT.test(path) || RTL_LETTER.test(path)) continue;
    const start = (match.index ?? 0) + match[1].length;
    pieces ??= [];
    if (start > cursor) {
      pieces.push({ type: "text", value: text.slice(cursor, start) });
    }
    pieces.push({
      type: "element",
      tagName: "bdi",
      properties: { dir: "ltr" },
      children: [{ type: "text", value: path }],
    });
    cursor = start + path.length;
  }
  if (pieces && cursor < text.length) {
    pieces.push({ type: "text", value: text.slice(cursor) });
  }
  return pieces;
}

function isolateBarePaths(node: HastNode): void {
  if (!node.children) return;
  let changed = false;
  const children: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      const pieces = isolateBarePathsInText(child.value ?? "");
      if (pieces) {
        children.push(...pieces);
        changed = true;
        continue;
      }
    } else if (
      child.type === "element" &&
      !ISOLATED_TAGS.has(child.tagName ?? "") &&
      !child.properties?.dir
    ) {
      isolateBarePaths(child);
    }
    children.push(child);
  }
  if (changed) node.children = children;
}

/**
 * Rehype plugin: set `dir` on each top-level block except code fences, and
 * isolate bare local paths inside right-to-left blocks.
 */
export function rehypeMarkdownDirection() {
  return (tree: HastNode): void => {
    for (const block of tree.children ?? []) {
      if (block.type !== "element" || block.tagName === "pre") continue;
      // Keep a direction the author set explicitly in allowed raw HTML.
      if (block.properties?.dir) continue;
      const direction = detectTextDirection(proseText(block));
      if (!direction) continue;
      block.properties = { ...block.properties, dir: direction };
      if (direction === "rtl") isolateBarePaths(block);
    }
  };
}
