import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  onSelect: jest.fn(),
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

it("selects by shortcut without adding a second submit action", () => {
  render(<UserInputQuestionPanel {...props} />);
  fireEvent.keyDown(document.body, { key: "2" });
  expect(props.onSelect).toHaveBeenCalledWith("b");
  act(() => jest.advanceTimersByTime(200));
  expect(
    screen.queryByRole("button", { name: /Submit|Next/ }),
  ).not.toBeInTheDocument();
});

it("keeps claimed choices fixed", () => {
  render(
    <UserInputQuestionPanel
      {...props}
      total={1}
      answersLocked
      answer={{ selectedValues: ["a"], customAnswer: "" }}
    />,
  );
  expect(screen.getByRole("button", { name: /Alpha/ })).toBeDisabled();
  fireEvent.keyDown(document.body, { key: "2" });
  expect(props.onSelect).not.toHaveBeenCalled();
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
  expect(
    screen.queryByRole("button", { name: /Submit|Next/ }),
  ).not.toBeInTheDocument();
});

it("prevents disabled selections and clears the selected appearance when custom text replaces a choice", () => {
  const { rerender } = render(<UserInputQuestionPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  rerender(<UserInputQuestionPanel {...props} disabled />);
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  rerender(<UserInputQuestionPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  rerender(
    <UserInputQuestionPanel
      {...props}
      answer={{ selectedValues: ["a"], customAnswer: "Gamma" }}
    />,
  );
  expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("does not change an answer from number keys inside an open dialog", () => {
  render(
    <>
      <UserInputQuestionPanel
        {...props}
        answer={{ selectedValues: [], customAnswer: "Keep this answer" }}
      />
      <div role="dialog">
        <button>Dialog action</button>
      </div>
    </>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Dialog action" }), {
    key: "1",
  });
  expect(props.onSelect).not.toHaveBeenCalled();
});

it("makes an overflowing question readable without changing the selected answer", () => {
  const scrollHeight = jest
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(200);
  const clientHeight = jest
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(80);
  try {
    render(
      <UserInputQuestionPanel
        {...props}
        disabled
        answer={{ selectedValues: ["a"], customAnswer: "" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Read full question" }));
    const dialog = screen.getByRole("dialog", { name: "Scope" });
    expect(within(dialog).getByText("Choose a scope")).toBeVisible();
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Close" }), {
      key: "2",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Alpha/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(props.onSelect).not.toHaveBeenCalled();
  } finally {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
});

it("does not add a full-question action when the question fits", () => {
  render(<UserInputQuestionPanel {...props} />);
  expect(
    screen.queryByRole("button", { name: "Read full question" }),
  ).not.toBeInTheDocument();
});
