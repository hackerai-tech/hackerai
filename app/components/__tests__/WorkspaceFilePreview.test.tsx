import { fireEvent, render, screen } from "@testing-library/react";
import WorkspaceFilePreview from "../WorkspaceFilePreview";
jest.mock("../ComputerCodeBlock", () => ({
  ComputerCodeBlock: ({ children }: { children: string }) => (
    <pre>{children}</pre>
  ),
}));
const callbacks = { onClose: jest.fn(), onDownload: jest.fn(), busy: false };
it("renders a bounded table then switches to the unmodified source", async () => {
  const raw = 'name,note\n"a,b","<script>alert(1)</script>"';
  render(
    <WorkspaceFilePreview
      {...callbacks}
      file={{ name: "report.csv", path: "reports/report.csv", text: raw }}
    />,
  );
  expect(
    screen.getByRole("table", { name: "Table report.csv" }),
  ).toHaveTextContent("a,b");
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Source", exact: true }));
  expect(
    await screen.findByText(
      (_, element) => element?.tagName === "PRE" && element.textContent === raw,
    ),
  ).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
it("renders Markdown in a sandboxed document and retains raw source for download", () => {
  render(
    <WorkspaceFilePreview
      {...callbacks}
      file={{
        name: "report.md",
        path: "report.md",
        text: "# Findings\n\n**Example**",
      }}
    />,
  );
  const frame = screen.getByTitle("Rendered report.md");
  expect(frame).toHaveAttribute("sandbox", "");
  expect(frame.getAttribute("srcdoc")).toContain("<h1>Findings</h1>");
  fireEvent.click(
    screen.getByRole("button", { name: "Download previewed file" }),
  );
  expect(callbacks.onDownload).toHaveBeenCalled();
});
