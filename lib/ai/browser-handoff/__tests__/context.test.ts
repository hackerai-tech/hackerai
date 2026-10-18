import type { ModelMessage } from "ai";
import { createBrowserHandoffNoteProjector } from "../context";

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
