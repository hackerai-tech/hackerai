import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ToolErrorDetail } from "../ToolErrorDetail";
import { createToolInputErrorContent } from "@/lib/chat/tool-error-display";

describe("ToolErrorDetail", () => {
  it("explains the failure and next step without showing raw parameters", () => {
    const content = createToolInputErrorContent({
      toolType: "tool-create_vulnerability_report",
      toolCallId: "finding-call",
      errorText:
        'Invalid input for tool create_vulnerability_report: Value: {"cve":"private"}. Error message: [{"code":"invalid_format","path":["cve"],"message":"private"}]',
    });

    render(<ToolErrorDetail content={content} />);

    expect(screen.getByText("What happened")).toBeVisible();
    expect(screen.getByText("What to do next")).toBeVisible();
    expect(
      screen.getByText("The vulnerability report wasn’t saved"),
    ).toBeVisible();
    expect(screen.getByText(/No finding was saved/)).toBeVisible();
    expect(screen.getByText("CVE")).toBeVisible();
    expect(screen.getByText("Invalid format")).toBeVisible();
    expect(screen.getByText(/raw validation data are not shown/)).toBeVisible();
    expect(screen.queryByText(/Value:/)).not.toBeInTheDocument();
    expect(screen.queryByText("private")).not.toBeInTheDocument();
  });
});
