import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { useFileUpload } from "../useFileUpload";
import {
  getLocalFileMetadata,
  pickLocalFiles,
  readLocalFile,
  removeGeneratedTextAttachment,
  writeGeneratedTextAttachment,
} from "@/app/hooks/useTauri";
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
  isTauriEnvironment: jest.fn(() => true),
  pickLocalFiles: jest.fn(),
  getLocalFileMetadata: jest.fn(),
  readLocalFile: jest.fn(),
  writeGeneratedTextAttachment: jest.fn(),
  removeGeneratedTextAttachment: jest.fn(),
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

describe("useFileUpload desktop-local agent attachments", () => {
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
      sandboxPreference: "desktop",
    };
    generateS3UploadUrlAction.mockResolvedValue({
      uploadUrl: "https://s3.example/upload",
      s3Key: "users/u1/report.txt",
    });
    saveFile.mockResolvedValue({
      url: "https://s3.example/download",
      fileId: "file_123",
      tokens: 10,
    });
    (writeGeneratedTextAttachment as jest.Mock).mockResolvedValue({
      path: "/Users/alice/Library/Application Support/HackerAI/generated-text-attachments/paste-1/pasted_content.txt",
      name: "pasted_content.txt",
      mediaType: "text/plain",
      size: 4100,
      lastModified: 123,
    });
    (removeGeneratedTextAttachment as jest.Mock).mockResolvedValue(true);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("uses Tauri file paths for large files without calling S3 in desktop Agent mode", async () => {
    (pickLocalFiles as jest.Mock).mockResolvedValue([
      "/Users/alice/report.txt",
    ]);
    (getLocalFileMetadata as jest.Mock).mockResolvedValue({
      path: "/Users/alice/report.txt",
      name: "report.txt",
      mediaType: "text/plain",
      size: 25 * 1024 * 1024,
      lastModified: 123,
    });

    const { result } = renderHook(() => useFileUpload("agent"));

    act(() => {
      result.current.handleAttachClick();
    });

    await waitFor(() => {
      expect(addUploadedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          uploaded: true,
          uploading: false,
          storage: "local-desktop",
          localPath: "/Users/alice/report.txt",
          localAttachmentId: expect.any(String),
        }),
      );
    });
    expect(generateS3UploadUrlAction).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("keeps generated pasted text local in desktop Agent mode", async () => {
    const pastedText = "A".repeat(4100);
    const event = createTextPasteEvent(pastedText);
    const { result } = renderHook(() => useFileUpload("agent"));

    let handled = false;
    await act(async () => {
      handled = await result.current.handlePasteEvent(event);
    });

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeGeneratedTextAttachment).toHaveBeenCalledWith(
      expect.any(String),
      "pasted_content.txt",
      pastedText,
    );
    expect(addUploadedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        uploaded: true,
        uploading: false,
        storage: "local-desktop",
        localAttachmentId: expect.any(String),
        localPath:
          "/Users/alice/Library/Application Support/HackerAI/generated-text-attachments/paste-1/pasted_content.txt",
        generatedSource: "pasted-text",
        generatedTextAttachmentId: expect.any(String),
        generatedTextAttachment: expect.objectContaining({
          content: pastedText,
        }),
      }),
    );
    expect(generateS3UploadUrlAction).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("updates generated pasted text locally without uploading edited content", async () => {
    const previousUpload = {
      file: {
        name: "pasted_content.txt",
        type: "text/plain",
        size: 8,
        lastModified: 1000,
      },
      uploading: false,
      uploaded: true,
      storage: "local-desktop" as const,
      generatedSource: "pasted-text" as const,
      generatedTextAttachmentId: "paste_1",
      localAttachmentId: "paste_1",
      localPath: "/Users/alice/pasted_content.txt",
      tokens: 0,
      generatedTextAttachment: {
        id: "paste_1",
        content: "original",
      },
    };
    globalState.uploadedFiles = [previousUpload];
    (writeGeneratedTextAttachment as jest.Mock).mockResolvedValueOnce({
      path: "/Users/alice/pasted_content.txt",
      name: "pasted_content.txt",
      mediaType: "text/plain",
      size: 6,
      lastModified: 2000,
    });
    const { result } = renderHook(() => useFileUpload("agent"));

    act(() => {
      result.current.handleUpdateGeneratedTextFile(0, "edited");
    });

    await waitFor(() => {
      expect(updateUploadedFile).toHaveBeenLastCalledWith(
        0,
        expect.objectContaining({
          uploaded: true,
          uploading: false,
          storage: "local-desktop",
          localPath: "/Users/alice/pasted_content.txt",
          generatedTextAttachment: {
            id: "paste_1",
            content: "edited",
          },
        }),
      );
    });
    expect(writeGeneratedTextAttachment).toHaveBeenCalledWith(
      "paste_1",
      "pasted_content.txt",
      "edited",
    );
    expect(generateS3UploadUrlAction).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("keeps large desktop-selected images local for sandbox-only Agent access", async () => {
    (pickLocalFiles as jest.Mock).mockResolvedValue(["/Users/alice/large.png"]);
    (getLocalFileMetadata as jest.Mock).mockResolvedValue({
      path: "/Users/alice/large.png",
      name: "large.png",
      mediaType: "image/png",
      size: 8 * 1024 * 1024,
      lastModified: 123,
    });

    const { result } = renderHook(() => useFileUpload("agent"));

    act(() => {
      result.current.handleAttachClick();
    });

    await waitFor(() => {
      expect(addUploadedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          uploaded: true,
          uploading: false,
          storage: "local-desktop",
          localPath: "/Users/alice/large.png",
        }),
      );
    });
    expect(readLocalFile).not.toHaveBeenCalled();
    expect(generateS3UploadUrlAction).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("uploads desktop-selected images through S3 for preview and model visibility", async () => {
    (pickLocalFiles as jest.Mock).mockResolvedValue(["/Users/alice/logo.svg"]);
    (getLocalFileMetadata as jest.Mock).mockResolvedValue({
      path: "/Users/alice/logo.svg",
      name: "logo.svg",
      mediaType: "image/svg+xml",
      size: 36,
      lastModified: 123,
    });
    (readLocalFile as jest.Mock).mockResolvedValue({
      path: "/Users/alice/logo.svg",
      name: "logo.svg",
      mediaType: "image/svg+xml",
      size: 36,
      lastModified: 123,
      base64: btoa("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
    });

    const { result } = renderHook(() => useFileUpload("agent"));

    act(() => {
      result.current.handleAttachClick();
    });

    await waitFor(() => {
      expect(generateS3UploadUrlAction).toHaveBeenCalledWith({
        fileName: "logo.svg",
        contentType: "image/svg+xml",
        size: expect.any(Number),
        mode: "agent",
      });
    });
    expect(addUploadedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        uploading: true,
        uploaded: false,
        storage: "s3",
      }),
    );
    expect(saveFile).toHaveBeenCalled();
  });

  it("falls back to a local desktop attachment when cloud image upload is rate limited", async () => {
    generateS3UploadUrlAction.mockRejectedValueOnce(
      new ConvexError({
        code: "FILE_UPLOAD_RATE_LIMIT",
        message:
          "You've reached your cloud file upload limit of 400 files per 5 hours.",
      }),
    );
    (pickLocalFiles as jest.Mock).mockResolvedValue(["/Users/alice/logo.svg"]);
    (getLocalFileMetadata as jest.Mock).mockResolvedValue({
      path: "/Users/alice/logo.svg",
      name: "logo.svg",
      mediaType: "image/svg+xml",
      size: 36,
      lastModified: 123,
    });
    (readLocalFile as jest.Mock).mockResolvedValue({
      path: "/Users/alice/logo.svg",
      name: "logo.svg",
      mediaType: "image/svg+xml",
      size: 36,
      lastModified: 123,
      base64: btoa("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
    });

    const { result } = renderHook(() => useFileUpload("agent"));

    act(() => {
      result.current.handleAttachClick();
    });

    await waitFor(() => {
      expect(updateUploadedFile).toHaveBeenCalledWith(
        0,
        expect.objectContaining({
          uploaded: true,
          uploading: false,
          storage: "local-desktop",
          localPath: "/Users/alice/logo.svg",
          tokens: 0,
        }),
      );
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("shows storage quota errors without logging an unexpected upload failure", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const message =
      "Storage limit exceeded. You are using 10.00 GB of 10 GB and this file requires 37.94 MB. Please delete some files to upload new ones.";
    generateS3UploadUrlAction.mockRejectedValueOnce(
      new ConvexError({
        code: "STORAGE_LIMIT_EXCEEDED",
        message,
      }),
    );
    const file = new File(["hello"], "report.txt", { type: "text/plain" });
    const { result } = renderHook(() => useFileUpload("ask"));

    await act(async () => {
      await result.current.handleFileUploadEvent({
        target: { files: [file] },
      } as any);
    });

    await waitFor(() => {
      expect(updateUploadedFile).toHaveBeenCalledWith(
        0,
        expect.objectContaining({
          uploading: false,
          uploaded: false,
          error: message,
        }),
      );
    });
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("keeps the S3 upload path outside desktop Agent mode", async () => {
    globalState.sandboxPreference = "e2b";
    const file = new File(["hello"], "report.txt", { type: "text/plain" });
    const { result } = renderHook(() => useFileUpload("agent"));

    await act(async () => {
      await result.current.handleFileUploadEvent({
        target: { files: [file] },
      } as any);
    });

    await waitFor(() => {
      expect(generateS3UploadUrlAction).toHaveBeenCalledWith({
        fileName: "report.txt",
        contentType: "text/plain",
        size: file.size,
        mode: "agent",
      });
    });
    expect(addUploadedFile).toHaveBeenCalledWith(
      expect.objectContaining({ uploading: true, uploaded: false }),
    );
  });
});
