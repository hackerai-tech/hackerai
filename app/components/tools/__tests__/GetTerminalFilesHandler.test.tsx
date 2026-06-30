import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";

jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: () => ({
    handleOpenInSidebar: jest.fn(),
    handleKeyDown: jest.fn(),
  }),
}));

const { GetTerminalFilesHandler } =
  require("../GetTerminalFilesHandler") as typeof import("../GetTerminalFilesHandler");

describe("GetTerminalFilesHandler", () => {
  it("targets only successfully shared files when an upload partially fails", () => {
    render(
      <GetTerminalFilesHandler
        status="ready"
        part={{
          toolCallId: "call-1",
          state: "output-available",
          input: {
            brief: "Deliver both packages",
            files: ["/home/user/server.zip", "/home/user/client.zip"],
          },
          output: {
            result: "Partially provided 1 of 2 file(s)",
            files: [{ path: "/home/user/server.zip" }],
            failedFiles: [
              { path: "/home/user/client.zip", reason: "upload failed" },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("Shared 1 of 2 files")).toBeInTheDocument();
    expect(screen.getByText("server.zip")).toBeInTheDocument();
    expect(screen.queryByText("client.zip")).not.toBeInTheDocument();
  });
});
