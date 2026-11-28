import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageEditor } from "../MessageEditor";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: "pro" }),
}));

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "keeps the edit open when Escape dismisses an IME candidate (%o)",
  (composition) => {
    const onCancel = jest.fn();
    render(
      <MessageEditor
        initialContent="ポートスキャン"
        onSave={jest.fn()}
        onCancel={onCancel}
      />,
    );
    const textarea = screen.getByRole("textbox");

    fireEvent.keyDown(textarea, { key: "Escape", ...composition });
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  },
);
