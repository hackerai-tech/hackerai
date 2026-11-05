import { downloadFile } from "../file-download";
import {
  saveFileToLocal,
  revealFileInDir,
  isTauriEnvironment,
} from "@/app/hooks/useTauri";
import { toast } from "sonner";

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: jest.fn(() => true),
  saveFileToLocal: jest.fn(),
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
