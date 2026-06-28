import { act, renderHook, waitFor } from "@testing-library/react";
import { useFileUpload } from "../useFileUpload";
import { toast } from "sonner";

const addUploadedFile = jest.fn();
const updateUploadedFile = jest.fn();
const removeUploadedFile = jest.fn();
const deleteFile = jest.fn();
const saveFile = jest.fn();
const generateS3UploadUrlAction = jest.fn();

let globalState: any;

jest.mock("convex/react", () => ({
  useMutation: () => deleteFile,
  useAction: (action: unknown) =>
    String(action).includes("generateS3UploadUrlAction")
      ? generateS3UploadUrlAction
      : saveFile,
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    fileStorage: { deleteFile: "deleteFile" },
    fileActions: { saveFile: "saveFile" },
    s3Actions: { generateS3UploadUrlAction: "generateS3UploadUrlAction" },
  },
}));

jest.mock("../../contexts/GlobalState", () => ({
  useGlobalState: () => globalState,
}));

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: jest.fn(() => false),
  pickLocalFiles: jest.fn(),
  getLocalFileMetadata: jest.fn(),
  readLocalFile: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  },
}));

type MockPasteEvent = ClipboardEvent & {
  preventDefault: jest.Mock;
};

const createTextPasteEvent = (text: string): MockPasteEvent =>
  ({
    clipboardData: {
      items: [],
      getData: jest.fn((type: string) =>
        type === "text/plain" || type === "text" ? text : "",
      ),
    },
    preventDefault: jest.fn(),
  }) as unknown as MockPasteEvent;

const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

describe("useFileUpload generated pasted text attachments", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
    globalState = {
      uploadedFiles: [],
      addUploadedFile,
      updateUploadedFile,
      removeUploadedFile,
      subscription: "pro",
      getTotalTokens: jest.fn(() => 0),
      sandboxPreference: "e2b",
    };
    generateS3UploadUrlAction.mockResolvedValue({
      uploadUrl: "https://s3.example/upload",
      s3Key: "users/u1/pasted_content.txt",
    });
    saveFile.mockResolvedValue({
      url: "https://s3.example/download",
      fileId: "file_123",
      tokens: 10,
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("converts large plain-text paste payloads into uploaded text files", async () => {
    const pastedText = `${"A".repeat(4100)}\nsource material`;
    const event = createTextPasteEvent(pastedText);
    const { result } = renderHook(() => useFileUpload("ask"));

    let handled = false;
    await act(async () => {
      handled = await result.current.handlePasteEvent(event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(addUploadedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        uploading: true,
        uploaded: false,
        storage: "s3",
        generatedTextAttachment: expect.objectContaining({
          content: pastedText,
        }),
      }),
    );

    const addedFile = addUploadedFile.mock.calls[0][0].file as File;
    expect(addedFile.name).toBe("pasted_content.txt");
    expect(addedFile.type).toBe("text/plain");
    await expect(readFileAsText(addedFile)).resolves.toBe(pastedText);

    await waitFor(() => {
      expect(generateS3UploadUrlAction).toHaveBeenCalledWith({
        fileName: "pasted_content.txt",
        contentType: "text/plain",
        size: addedFile.size,
        mode: "ask",
      });
    });
  });

  it("does not intercept small text snippets", async () => {
    const event = createTextPasteEvent("short pasted note");
    const { result } = renderHook(() => useFileUpload("ask"));

    let handled = true;
    await act(async () => {
      handled = await result.current.handlePasteEvent(event);
    });

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(addUploadedFile).not.toHaveBeenCalled();
  });

  it("allows free users to paste large text inline when file attachments are unavailable", async () => {
    globalState.subscription = "free";
    const event = createTextPasteEvent("A".repeat(4100));
    const { result } = renderHook(() => useFileUpload("ask"));

    let handled = true;
    await act(async () => {
      handled = await result.current.handlePasteEvent(event);
    });

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(addUploadedFile).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("creates distinct generated filenames for multiple large pastes", async () => {
    globalState.uploadedFiles = [
      {
        file: new File(["first"], "pasted_content.txt", {
          type: "text/plain",
        }),
        uploading: false,
        uploaded: true,
        storage: "s3",
      },
    ];
    const event = createTextPasteEvent("B".repeat(4100));
    const { result } = renderHook(() => useFileUpload("ask"));

    await act(async () => {
      await result.current.handlePasteEvent(event);
    });

    const addedFile = addUploadedFile.mock.calls[0][0].file as File;
    expect(addedFile.name).toBe("pasted_content_2.txt");
  });

  it("does not create a file for whitespace-only large paste payloads", async () => {
    const event = createTextPasteEvent(" ".repeat(4100));
    const { result } = renderHook(() => useFileUpload("ask"));

    let handled = false;
    await act(async () => {
      handled = await result.current.handlePasteEvent(event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(addUploadedFile).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      "No readable text was added from the paste.",
    );
  });

  it("restores the previous generated text file when edited replacement upload fails", async () => {
    const originalFile = new File(["original"], "pasted_content.txt", {
      type: "text/plain",
      lastModified: 1000,
    });
    const previousUpload = {
      file: originalFile,
      uploading: false,
      uploaded: true,
      storage: "s3" as const,
      fileId: "file_old",
      url: "https://s3.example/old",
      tokens: 5,
      generatedSource: "pasted-text" as const,
      generatedTextAttachment: {
        id: "paste_1",
        content: "original",
      },
    };
    globalState.uploadedFiles = [previousUpload];
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, statusText: "upload failed" }) as any;
    const { result } = renderHook(() => useFileUpload("ask"));

    await act(async () => {
      result.current.handleUpdateGeneratedTextFile(0, "edited");
    });

    await waitFor(() => {
      expect(updateUploadedFile).toHaveBeenLastCalledWith(0, previousUpload);
    });
    expect(deleteFile).not.toHaveBeenCalledWith({ fileId: "file_old" });
  });
});
