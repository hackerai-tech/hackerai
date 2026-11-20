import { downloadFile } from "../file-download";
import {
  saveFileToLocal,
  saveBinaryFileToLocal,
  revealFileInDir,
  isTauriEnvironment,
} from "@/app/hooks/useTauri";
import { toast } from "sonner";

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: jest.fn(() => true),
  saveFileToLocal: jest.fn(),
  saveBinaryFileToLocal: jest.fn(),
  revealFileInDir: jest.fn(),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const save = jest.mocked(saveFileToLocal);
const report = {
  filename: "finding.md",
  content: "```python\nprint(1 + 1)\n```\n[Evidence](https://example.test)",
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isTauriEnvironment).mockReturnValue(true);
});

it("keeps a browser file available for asynchronous download and eventually releases it", async () => {
  jest.useFakeTimers();
  jest.mocked(isTauriEnvironment).mockReturnValue(false);
  const create = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const blobs = new Set<string>();
  let browserCouldReadFile = false;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: jest.fn(() => {
      blobs.add("blob:report");
      return "blob:report";
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: jest.fn((url: string) => blobs.delete(url)),
  });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function () {
      const url = this.href;
      setTimeout(() => {
        browserCouldReadFile = blobs.has(url);
      }, 0);
    });
  try {
    await expect(downloadFile(report)).resolves.toEqual({
      outcome: "initiated",
    });
    jest.advanceTimersByTime(0);
    expect(browserCouldReadFile).toBe(true);
    jest.runOnlyPendingTimers();
    expect(blobs.size).toBe(0);
  } finally {
    click.mockRestore();
    if (create) Object.defineProperty(URL, "createObjectURL", create);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revoke) Object.defineProperty(URL, "revokeObjectURL", revoke);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    jest.useRealTimers();
  }
});

it("silently cancels a native save without reporting success or failure", async () => {
  save.mockResolvedValue(null);
  await expect(downloadFile(report)).resolves.toEqual({ outcome: "canceled" });
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});

it("reports a native write failure without rejecting the UI click", async () => {
  save.mockRejectedValue(new Error("Permission denied"));
  await expect(downloadFile(report)).resolves.toEqual({ outcome: "failed" });
  expect(toast.error).toHaveBeenCalledWith("Failed to save file");
  expect(toast.success).not.toHaveBeenCalled();
});

it("preserves content and reveals the user-selected destination after saving", async () => {
  save.mockResolvedValue("/chosen/report.md");
  await expect(downloadFile(report)).resolves.toEqual({ outcome: "success" });
  expect(save).toHaveBeenCalledWith(report.filename, report.content);
  const options = jest.mocked(toast.success).mock.calls[0][1];
  options?.action &&
    typeof options.action === "object" &&
    options.action.onClick(new MouseEvent("click") as never);
  expect(revealFileInDir).toHaveBeenCalledWith("/chosen/report.md");
});

it("identifies an older Desktop shell without a save command", async () => {
  save.mockRejectedValue("Command save_file_with_dialog not found");
  await expect(downloadFile(report)).resolves.toEqual({
    outcome: "failed",
    reason: "unsupported_native",
  });
  expect(toast.error).toHaveBeenCalledWith("Update Desktop to save reports");
});

it("saves binary reports byte-for-byte without passing them to the text command", async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255, 128]);
  jest.mocked(saveBinaryFileToLocal).mockResolvedValue("/chosen/report.pdf");
  await expect(
    downloadFile({
      filename: "report.pdf",
      content: bytes,
      mimeType: "application/pdf",
    }),
  ).resolves.toEqual({ outcome: "success" });
  expect(saveBinaryFileToLocal).toHaveBeenCalledWith("report.pdf", bytes);
  expect(save).not.toHaveBeenCalled();
});
it("requires a Desktop update when the binary command is unavailable", async () => {
  jest
    .mocked(saveBinaryFileToLocal)
    .mockRejectedValue("Command save_binary_file_with_dialog not found");
  await expect(
    downloadFile({
      filename: "report.pdf",
      content: new Uint8Array([37, 80, 68, 70]),
    }),
  ).resolves.toEqual({ outcome: "failed", reason: "unsupported_native" });
  expect(save).not.toHaveBeenCalled();
});

describe("lazy content in the browser save picker", () => {
  const events: string[] = [];
  const write = jest.fn(async (_data: unknown) => {
    events.push("write");
  });
  const pickerWith = (pick: () => Promise<unknown>) => {
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = jest.fn(
      () => {
        events.push("picker");
        return pick();
      },
    );
  };
  const handle = {
    createWritable: async () => {
      events.push("createWritable");
      return { write, close: async () => {} };
    },
  };
  beforeEach(() => {
    events.length = 0;
    jest.mocked(isTauriEnvironment).mockReturnValue(false);
  });
  afterEach(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  it("opens the picker before loading and creates the writable only after bytes resolve", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
    pickerWith(async () => handle);
    const content = jest.fn(async () => {
      events.push("load");
      return bytes;
    });
    await expect(
      downloadFile({ filename: "report.pdf", content }),
    ).resolves.toEqual({ outcome: "success" });
    expect(events).toEqual(["picker", "load", "createWritable", "write"]);
    expect(write).toHaveBeenCalledWith(bytes);
  });

  it("does no loading or writing when the picker is canceled", async () => {
    pickerWith(async () => {
      throw new DOMException("canceled", "AbortError");
    });
    const content = jest.fn(async () => "never");
    await expect(downloadFile({ filename: "a.txt", content })).resolves.toEqual(
      {
        outcome: "canceled",
      },
    );
    expect(content).not.toHaveBeenCalled();
    expect(events).toEqual(["picker"]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("rejects with the loader's error without opening a writable", async () => {
    pickerWith(async () => handle);
    const failure = new Error("Saved file is unavailable.");
    await expect(
      downloadFile({
        filename: "a.pdf",
        content: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual(["picker"]);
    expect(toast.success).not.toHaveBeenCalled();
  });
});

it("loads lazy content before the native dialog and saves exact bytes", async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
  jest.mocked(saveBinaryFileToLocal).mockResolvedValue("/chosen/report.pdf");
  await expect(
    downloadFile({ filename: "report.pdf", content: async () => bytes }),
  ).resolves.toEqual({ outcome: "success" });
  expect(saveBinaryFileToLocal).toHaveBeenCalledWith("report.pdf", bytes);
  expect(save).not.toHaveBeenCalled();
});

it.each([
  "save_binary_file_with_dialog not allowed. Command not found",
  "Command save_binary_file_with_dialog not allowed by ACL",
  "save_file_with_dialog not allowed. Command not found",
  "Command save_file_with_dialog not allowed by ACL",
])(
  "shows the Desktop update instruction for an older shell ACL: %s",
  async (error) => {
    save.mockRejectedValue(error);
    jest.mocked(saveBinaryFileToLocal).mockRejectedValue(error);
    await expect(
      downloadFile({
        filename: "report.pdf",
        content: error.includes("binary_")
          ? new Uint8Array([37, 80, 68, 70])
          : "report text",
      }),
    ).resolves.toEqual({ outcome: "failed", reason: "unsupported_native" });
    expect(toast.error).toHaveBeenCalledWith("Update Desktop to save reports");
  },
);
