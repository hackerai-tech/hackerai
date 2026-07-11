export const MIN_MESSAGE_SEARCH_QUERY_LENGTH = 3;
export const MAX_MESSAGE_SEARCH_QUERY_LENGTH = 256;

export type MessageSearchTextSegment = {
  text: string;
  isMatch: boolean;
};

const SEARCH_COLLATOR = new Intl.Collator(undefined, {
  usage: "search",
  sensitivity: "accent",
});

const findCaseInsensitiveMatch = (
  text: string,
  query: string,
  fromIndex: number,
): number => {
  const lastStartIndex = text.length - query.length;
  for (let index = fromIndex; index <= lastStartIndex; index += 1) {
    if (
      SEARCH_COLLATOR.compare(
        text.slice(index, index + query.length),
        query,
      ) === 0
    ) {
      return index;
    }
  }
  return -1;
};

/**
 * Split text around literal, case-insensitive matches without compiling user
 * input as a regular expression. This keeps large or regex-like pasted input
 * from becoming part of a browser SyntaxError.
 */
export function splitTextBySearchTerm(
  text: string,
  searchTerm: string,
): MessageSearchTextSegment[] {
  const query = searchTerm.trim();
  if (!query || query.length > MAX_MESSAGE_SEARCH_QUERY_LENGTH) {
    return [{ text, isMatch: false }];
  }

  const segments: MessageSearchTextSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = findCaseInsensitiveMatch(text, query, cursor);
    if (matchIndex === -1) break;

    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), isMatch: false });
    }
    segments.push({
      text: text.slice(matchIndex, matchIndex + query.length),
      isMatch: true,
    });
    cursor = matchIndex + query.length;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), isMatch: false });
  }

  return segments.length > 0 ? segments : [{ text, isMatch: false }];
}
