import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { UserInputQuestionPanel } from "../UserInputQuestionPanel";

const question = {
  id: "scope",
  header: "Scope",
  question: "Choose a scope",
  options: [
    { label: "Alpha", value: "a", description: "First option" },
    { label: "Beta", value: "b" },
  ],
};
const props = {
  question,
  answer: { selectedValues: [], customAnswer: "" },
  index: 0,
  total: 2,
  disabled: false,
  canAdvance: false,
  onSelect: jest.fn(),
  onAdvance: jest.fn(),
  onBack: jest.fn(),
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

it("selects by shortcut and advances a single-choice question once", () => {
  render(<UserInputQuestionPanel {...props} />);
  fireEvent.keyDown(document.body, { key: "2" });
  expect(props.onSelect).toHaveBeenCalledWith("b");
  act(() => jest.advanceTimersByTime(200));
  expect(props.onAdvance).toHaveBeenCalledTimes(1);
});

it("keeps claimed choices fixed while allowing an explicit retry", () => {
  render(
    <UserInputQuestionPanel
      {...props}
      total={1}
      answersLocked
      canAdvance
      answer={{ selectedValues: ["a"], customAnswer: "" }}
    />,
  );
  expect(screen.getByRole("button", { name: /Alpha/ })).toBeDisabled();
  fireEvent.keyDown(document.body, { key: "2" });
  expect(props.onSelect).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Submit answer", exact: true }),
  );
  expect(props.onAdvance).toHaveBeenCalledTimes(1);
});

it("does not intercept numbers typed into the composer or advance multi-select", () => {
  render(
    <>
      <textarea aria-label="Custom answer" />
      <UserInputQuestionPanel
        {...props}
        question={{ ...question, multiSelect: true }}
      />
    </>,
  );
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "1" });
  expect(props.onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  act(() => jest.advanceTimersByTime(250));
  expect(props.onSelect).toHaveBeenCalledWith("a");
  expect(props.onAdvance).not.toHaveBeenCalled();
});

it("cancels pending auto-advance when the request is disabled or custom text replaces a choice", () => {
  const { rerender } = render(<UserInputQuestionPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  rerender(<UserInputQuestionPanel {...props} disabled />);
  act(() => jest.advanceTimersByTime(250));
  expect(props.onAdvance).not.toHaveBeenCalled();
  rerender(<UserInputQuestionPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  rerender(
    <UserInputQuestionPanel
      {...props}
      answer={{ selectedValues: ["a"], customAnswer: "Gamma" }}
    />,
  );
  act(() => jest.advanceTimersByTime(250));
  expect(props.onAdvance).not.toHaveBeenCalled();
});
