import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessagePartHandler } from "../MessagePartHandler";
import { useToolSidebar } from "../../hooks/useToolSidebar";

jest.mock("../../hooks/useToolSidebar", () => ({ useToolSidebar: jest.fn() }));
const openSidebar = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useToolSidebar).mockReturnValue({
    handleOpenInSidebar: openSidebar,
    handleKeyDown: jest.fn(),
    isSidebarActive: false,
  });
});

it.each(["tool-file", "tool-file_write"])(
  "renders and opens a saved %s write",
  (type) => {
    const part = {
      type,
      toolCallId: "write-notes",
      state: "output-available",
      input: {
        action: "write",
        path: "/project/notes.txt",
        text: "saved notes\n",
      },
      output: { success: true },
    };
    const message = { id: "message", role: "assistant", parts: [part] } as any;
    render(
      <MessagePartHandler
        message={message}
        part={part as any}
        partIndex={0}
        status="ready"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /notes.txt.*sidebar/i }),
    );
    expect(openSidebar).toHaveBeenCalledTimes(1);
    expect(useToolSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "write-notes",
        content: expect.objectContaining({
          path: "/project/notes.txt",
          content: "saved notes\n",
          isExecuting: false,
        }),
      }),
    );
  },
);
