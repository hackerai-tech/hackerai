import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeedbackInput } from "../FeedbackInput";

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "does not send when Enter confirms an IME candidate (%o)",
  async (composition) => {
    const onSend = jest.fn().mockResolvedValue(undefined);
    render(<FeedbackInput onSend={onSend} onCancel={jest.fn()} />);
    const textarea = screen.getByPlaceholderText("What went wrong?");
    fireEvent.change(textarea, { target: { value: "回答が途中" } });

    fireEvent.keyDown(textarea, { key: "Enter", ...composition });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("回答が途中"));
  },
);
