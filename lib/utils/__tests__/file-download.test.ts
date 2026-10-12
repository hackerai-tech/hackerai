import { downloadFile } from "../file-download";
import { saveFileToLocal, revealFileInDir } from "@/app/hooks/useTauri";
import { toast } from "sonner";

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => true,
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

beforeEach(() => jest.clearAllMocks());

it("silently cancels a native save without reporting success or failure", async () => {
  save.mockResolvedValue(null);
  await downloadFile(report);
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});

it("reports a native write failure without rejecting the UI click", async () => {
  save.mockRejectedValue(new Error("Permission denied"));
  await expect(downloadFile(report)).resolves.toBeUndefined();
  expect(toast.error).toHaveBeenCalledWith("Failed to save file");
  expect(toast.success).not.toHaveBeenCalled();
});

it("preserves content and reveals the user-selected destination after saving", async () => {
  save.mockResolvedValue("/chosen/report.md");
  await downloadFile(report);
  expect(save).toHaveBeenCalledWith(report.filename, report.content);
  const options = jest.mocked(toast.success).mock.calls[0][1];
  options?.action &&
    typeof options.action === "object" &&
    options.action.onClick(new MouseEvent("click") as never);
  expect(revealFileInDir).toHaveBeenCalledWith("/chosen/report.md");
});
