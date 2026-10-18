import type { ModelMessage } from "ai";
import { appendBrowserHandoffNotes } from "../context";

it("deduplicates retained and repeated private notes without modifying history", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "Signed in!" }];
  const result = appendBrowserHandoffNotes(messages, [
    { text: "Signed in!" },
    { text: "Changed NAME.AZ!" },
    { text: "Changed NAME.AZ!" },
  ]);
  expect(result).toEqual([
    ...messages,
    { role: "user", content: "Changed NAME.AZ!" },
  ]);
  expect(messages).toHaveLength(1);
  expect(
    appendBrowserHandoffNotes(result, [{ text: "Changed NAME.AZ!" }]),
  ).toEqual(result);
});

it("restores context after compaction removes it and does not mistake assistant text for a note", () => {
  const messages: ModelMessage[] = [
    { role: "assistant", content: "Signed in!" },
  ];
  expect(appendBrowserHandoffNotes(messages, [{ text: "Signed in!" }])).toEqual(
    [...messages, { role: "user", content: "Signed in!" }],
  );
  expect(appendBrowserHandoffNotes([], [{ text: "Signed in!" }])).toEqual([
    { role: "user", content: "Signed in!" },
  ]);
});
