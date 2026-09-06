import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { downloadFile } from "@/lib/utils/file-download";
import { MarkdownTable } from "../MarkdownTable";

jest.mock("@/lib/utils/file-download", () => ({
  downloadFile: jest.fn(),
}));

const mockedDownloadFile = jest.mocked(downloadFile);

class TestBlob {
  readonly content: string;
  readonly type: string;

  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    this.content = parts.map(String).join("");
    this.type = options?.type || "";
  }
}

class TestClipboardItem {
  constructor(readonly data: Record<string, TestBlob>) {}
}

const clipboardWrite = jest.fn();
const clipboardWriteText = jest.fn();
const originalBlob = globalThis.Blob;
const originalClipboardItem = globalThis.ClipboardItem;
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

describe("MarkdownTable", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "Blob", {
      configurable: true,
      value: TestBlob,
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: clipboardWrite.mockResolvedValue(undefined),
        writeText: clipboardWriteText.mockResolvedValue(undefined),
      },
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "Blob", {
      configurable: true,
      value: originalBlob,
    });
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: originalClipboardItem,
    });
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("downloads formula-like cells as literal spreadsheet text", () => {
    render(
      <MarkdownTable>
        <tbody>
          <tr>
            <td>Label</td>
            <td>Value</td>
          </tr>
          <tr>
            <td>Equals</td>
            <td>=HYPERLINK(&quot;https://example.test&quot;)</td>
          </tr>
          <tr>
            <td>Plus</td>
            <td>+SUM(1,2)</td>
          </tr>
          <tr>
            <td>Minus</td>
            <td>-1+2</td>
          </tr>
          <tr>
            <td>At</td>
            <td>@SUM(1,2)</td>
          </tr>
          <tr>
            <td>Full width</td>
            <td>＝SUM(1,2)</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    fireEvent.click(screen.getByTitle("Download as CSV"));

    expect(mockedDownloadFile).toHaveBeenCalledWith({
      filename: "table.csv",
      content: [
        '"Label","Value"',
        '"Equals","\'=HYPERLINK(""https://example.test"")"',
        '"Plus","\'+SUM(1,2)"',
        '"Minus","\'-1+2"',
        '"At","\'@SUM(1,2)"',
        '"Full width","\'＝SUM(1,2)"',
      ].join("\r\n"),
      mimeType: "text/csv",
    });
  });

  it("copies safe plain-text and rich table representations", async () => {
    render(
      <MarkdownTable>
        <tbody>
          <tr>
            <th>Value</th>
            <th>Details</th>
          </tr>
          <tr>
            <td>
              <strong>=1+1</strong>
            </td>
            <td>{"line\nbreak\tcell"}</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    fireEvent.click(screen.getByTitle("Copy table"));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const [items] = clipboardWrite.mock.calls[0] as [[TestClipboardItem]];
    const payload = items[0].data;

    expect(payload["text/plain"].content).toBe(
      "Value\tDetails\r\n'=1+1\tline break cell",
    );
    expect(payload["text/html"].content).toContain(
      "<td>'<strong>=1+1</strong></td>",
    );
    expect(payload["text/html"].content).not.toContain(
      "<td><strong>=1+1</strong></td>",
    );
    expect(screen.getByText("=1+1").closest("td")?.innerHTML).toBe(
      "<strong>=1+1</strong>",
    );
  });

  it("uses the same safe TSV for the plain-text clipboard fallback", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("rich copy unavailable"));

    render(
      <MarkdownTable>
        <tbody>
          <tr>
            <td>=1+1</td>
            <td>{"line\nbreak"}</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );

    fireEvent.click(screen.getByTitle("Copy table"));

    await waitFor(() =>
      expect(clipboardWriteText).toHaveBeenCalledWith("'=1+1\tline break"),
    );
  });
});
