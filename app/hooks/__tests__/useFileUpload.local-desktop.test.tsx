import { act, renderHook, waitFor } from "@testing-library/react";
import { useFileUpload } from "../useFileUpload";
import {
  getLocalFileMetadata,
  pickLocalFiles,
  readLocalFile,
} from "@/app/hooks/useTauri";

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
}));

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
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("uses Tauri file paths without calling S3 in desktop Agent mode", async () => {
    (pickLocalFiles as jest.Mock).mockResolvedValue([
      "/Users/alice/report.txt",
    ]);
    (getLocalFileMetadata as jest.Mock).mockResolvedValue({
      path: "/Users/alice/report.txt",
      name: "report.txt",
      mediaType: "text/plain",
      size: 1024,
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
      });
    });
    expect(addUploadedFile).toHaveBeenCalledWith(
      expect.objectContaining({ uploading: true, uploaded: false }),
    );
  });
});
