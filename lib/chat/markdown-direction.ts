/**
 * Gives each top-level Markdown block the direction of its own prose, so an
 * Arabic or Hebrew paragraph reads right to left while English blocks in the
 * same reply stay left to right. It runs after the sanitize and harden plugins
 * and only adds a literal `dir` attribute; text is never changed.
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
      const value = node.value ?? "";
      parts.push(value);
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

/** Rehype plugin: set `dir` on each top-level block except code fences. */
export function rehypeMarkdownDirection() {
  return (tree: HastNode): void => {
    for (const block of tree.children ?? []) {
      if (block.type !== "element" || block.tagName === "pre") continue;
      // Keep a direction the author set explicitly in allowed raw HTML.
      if (block.properties?.dir) continue;
      const direction = detectTextDirection(proseText(block));
      if (direction) block.properties = { ...block.properties, dir: direction };
    }
  };
}
