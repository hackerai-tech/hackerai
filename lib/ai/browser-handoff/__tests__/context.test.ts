import type { ModelMessage } from "ai";
import { createBrowserHandoffNoteProjector } from "../context";

it("keeps a new handoff at its own position even when earlier user text matches", () => {
  const project = createBrowserHandoffNoteProjector();
  const original: ModelMessage[] = [
    { role: "user", content: "Signed in." },
    { role: "assistant", content: "Opened another account." },
  ];
  const notes = [{ id: "first", text: "Signed in." }];
  const first = project(original, notes);
  expect(first).toEqual([...original, { role: "user", content: "Signed in." }]);
  expect(
    project(
      first.map((message) => ({ ...message })),
      notes,
    ),
  ).toEqual(first);
  const later = [
    ...first,
    { role: "assistant", content: "Opened a new page." } as ModelMessage,
  ];
  const second = project(later, [
    ...notes,
    { id: "second", text: "Signed in." },
  ]);
  expect(second).toEqual([...later, { role: "user", content: "Signed in." }]);
  expect(
    project(
      second.map((message) => ({ ...message })),
      [...notes, { id: "second", text: "Signed in." }],
    ),
  ).toEqual(second);
});

it("keeps takeover updates before subsequent responses when SDK input omits them", () => {
  const project = createBrowserHandoffNoteProjector();
  const original: ModelMessage[] = [{ role: "user", content: "Inspect" }];
  const notes = [{ id: "1", text: "Changed NAME.AZ!?" }];
  const first = project(original, notes);
  const completed: ModelMessage = {
    role: "assistant",
    content: "Read NAME.AZ!? and closed the browser.",
  };
  expect(project([...original, completed], notes)).toEqual([
    ...first,
    completed,
  ]);
  expect(project([...first, completed], notes)).toEqual([...first, completed]);
  expect(original).toHaveLength(1);
});

it("restores compacted notes in order before retained actions without replaying a new turn", () => {
  const project = createBrowserHandoffNoteProjector();
  const notes = [
    { id: "1", text: "Signed in." },
    { id: "2", text: "Selected the lab." },
  ];
  project([{ role: "user", content: "Inspect" }], notes);
  const compacted: ModelMessage[] = [
    { role: "system", content: "Summary" },
    { role: "assistant", content: "Completed the lab." },
  ];
  const restored = project(compacted, notes);
  expect(restored).toEqual([
    compacted[0],
    ...notes.map(({ text }) => ({ role: "user", content: text })),
    compacted[1],
  ]);
  expect(project(compacted, notes)).toEqual(restored);
  expect(
    project(restored, [
      ...notes,
      { id: "3", text: "Now inspect another page." },
    ]).at(-1),
  ).toEqual({ role: "user", content: "Now inspect another page." });
});
