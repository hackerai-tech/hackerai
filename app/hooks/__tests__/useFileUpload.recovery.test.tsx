import { act, renderHook } from "@testing-library/react";
import {
  createContext,
  useContext,
  useCallback,
  useState,
  type ReactNode,
} from "react";
import { useFileUpload } from "../useFileUpload";
import { UploadedFileState } from "@/types/file";

const deleteFile = jest.fn().mockResolvedValue(undefined);
const saveFile = jest.fn();
const generateS3UploadUrlAction = jest.fn();
const StateContext = createContext<any>(null);
jest.mock("convex/react", () => ({
  useConvex: () => ({ query: jest.fn().mockResolvedValue("complete") }),
  useMutation: () => deleteFile,
  useAction: (action: unknown) =>
    String(action).includes("generateS3UploadUrlAction")
      ? generateS3UploadUrlAction
      : saveFile,
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    deletions: { getStatusForUser: "getStatusForUser" },
    fileStorage: { deleteFile: "deleteFile" },
    fileActions: { saveFile: "saveFile" },
    s3Actions: { generateS3UploadUrlAction: "generateS3UploadUrlAction" },
  },
}));
jest.mock("../../contexts/GlobalState", () => ({
  useGlobalState: () => useContext(StateContext),
}));
jest.mock("@/lib/storage/file-storage-region", () => ({
  getPreferredFileStorageRegion: async () => undefined,
}));
jest.mock("@/app/hooks/useTauri", () => ({ isTauriEnvironment: () => false }));
jest.mock("sonner", () => ({
  toast: {
    loading: jest.fn(),
    dismiss: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  },
}));

function HarnessProvider({ children }: { children: ReactNode }) {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileState[]>([]);
  const addUploadedFile = useCallback(
    (file: UploadedFileState) => setUploadedFiles((prev) => [...prev, file]),
    [],
  );
  const updateUploadedFile = useCallback(
    (
      target: number | UploadedFileState["file"],
      updates: Partial<UploadedFileState>,
    ) =>
      setUploadedFiles((prev) =>
        prev.map((file, index) =>
          (typeof target === "number" ? index === target : file.file === target)
            ? { ...file, ...updates }
            : file,
        ),
      ),
    [],
  );
  const removeUploadedFile = useCallback(
    (target: number | UploadedFileState["file"]) =>
      setUploadedFiles((prev) =>
        prev.filter((file, index) =>
          typeof target === "number" ? index !== target : file.file !== target,
        ),
      ),
    [],
  );
  const globalState = {
    uploadedFiles,
    addUploadedFile,
    updateUploadedFile,
    removeUploadedFile,
    subscription: "pro",
    getTotalTokens: () => 0,
    sandboxPreference: "e2b",
    clear: () => setUploadedFiles([]),
  };
  return (
    <StateContext.Provider value={globalState}>
      {children}
    </StateContext.Provider>
  );
}
function useHarness(mode: "ask" | "agent" = "agent") {
  const globalState = useContext(StateContext);
  return {
    picker: useFileUpload(mode),
    preview: useFileUpload(mode),
    uploadedFiles: globalState.uploadedFiles as UploadedFileState[],
    clear: globalState.clear,
  };
}
const file = (name: string) =>
  new File(["test attachment"], name, { type: "text/plain" });
const select = (files: File[]) =>
  ({
    target: { files, value: "" },
  }) as unknown as React.ChangeEvent<HTMLInputElement>;
const tick = async (ms = 0) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
};

describe("browser attachment recovery", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    generateS3UploadUrlAction.mockResolvedValue({
      uploadUrl: "https://s3.example/upload",
      s3Key: "users/test/reservation",
    });
    saveFile.mockResolvedValue({
      fileId: "saved-file",
      url: "https://s3.example/download",
      tokens: 0,
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("retries a transient transfer against one reservation and finalizes once", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError("offline"));
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    await tick(1000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(generateS3UploadUrlAction).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploaded: true,
      uploading: false,
    });
  });

  it("allows explicit retry from another hook without a new reservation or duplicate requests", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("offline"));
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    await tick(3000);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploading: false,
      retryable: true,
    });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    act(() => {
      result.current.preview.handleRetryFile(0);
      result.current.preview.handleRetryFile(0);
    });
    await tick();
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(generateS3UploadUrlAction).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploaded: true,
      error: undefined,
      retryable: false,
    });
  });

  it("cancels removed work across hook instances and keeps the remaining attachment identity", async () => {
    const pending: Array<{
      resolve: (value: unknown) => void;
      signal: AbortSignal;
    }> = [];
    (global.fetch as jest.Mock).mockImplementation(
      (_url, options) =>
        new Promise((resolve) =>
          pending.push({ resolve, signal: options.signal }),
        ),
    );
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("first.txt"), file("second.txt")]),
      );
    });
    await act(async () => {
      await result.current.preview.handleRemoveFile(0);
    });
    expect(pending[0].signal.aborted).toBe(true);
    await act(async () => {
      pending[0].resolve({ ok: true });
      pending[1].resolve({ ok: true });
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile.mock.calls[0][0].name).toBe("second.txt");
    expect(result.current.uploadedFiles).toHaveLength(1);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploaded: true,
      fileId: "saved-file",
    });
  });

  it("cancels retry timers when attachments clear", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("offline"));
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    act(() => result.current.clear());
    await tick(10000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("cleans up a finalized file when removal wins the race", async () => {
    let finish!: (value: unknown) => void;
    saveFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    await act(async () => {
      await result.current.preview.handleRemoveFile(0);
      finish({ fileId: "late-file", url: "url", tokens: 0 });
    });
    expect(result.current.uploadedFiles).toHaveLength(0);
    expect(deleteFile).toHaveBeenCalledWith({ fileId: "late-file" });
  });

  it("does not retry denied uploads or metadata finalization", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 403,
    });
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("denied.txt")]),
      );
    });
    expect(result.current.uploadedFiles[0]).toMatchObject({
      retryable: false,
      uploaded: false,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    saveFile.mockRejectedValueOnce(new Error("metadata failed"));
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("metadata.txt")]),
      );
    });
    await tick(10000);
    expect(result.current.uploadedFiles[1]).toMatchObject({
      retryable: false,
      uploaded: false,
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("replaces generated pasted text using the previous file identity", async () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handlePastedTextAttachment("x".repeat(5000));
    });
    const original = result.current.uploadedFiles[0].file;
    expect(result.current.uploadedFiles[0].uploaded).toBe(true);
    await act(async () => {
      result.current.preview.handleUpdateGeneratedTextFile(0, "replacement");
    });
    expect(result.current.uploadedFiles[0].file).not.toBe(original);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploaded: true,
      generatedTextAttachment: { content: "replacement" },
    });
  });

  it("resumes a bounded retry when the browser reconnects", async () => {
    const online = jest
      .spyOn(navigator, "onLine", "get")
      .mockReturnValue(false);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError("offline"));
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(generateS3UploadUrlAction).toHaveBeenCalledTimes(1);
    expect(result.current.uploadedFiles[0].uploaded).toBe(true);
  });

  it("bounds hung transport requests and exposes retry after the last timeout", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          ),
        ),
    );
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    await tick(3 * 5 * 60_000 + 3_000);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploading: false,
      uploaded: false,
      retryable: true,
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("keeps repeat selections of the same File independently removable", async () => {
    const sameFile = file("report.txt");
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([sameFile, sameFile]),
      );
    });
    expect(result.current.uploadedFiles).toHaveLength(2);
    expect(result.current.uploadedFiles[0].file).not.toBe(
      result.current.uploadedFiles[1].file,
    );
    await act(async () => {
      await result.current.preview.handleRemoveFile(0);
    });
    expect(result.current.uploadedFiles).toHaveLength(1);
  });

  it("keeps the original upload mode when a failed attachment is retried", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("offline"));
    const { result, rerender } = renderHook(
      ({ mode }: { mode: "ask" | "agent" }) => useHarness(mode),
      { wrapper: HarnessProvider, initialProps: { mode: "agent" } },
    );
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    await tick(3000);
    rerender({ mode: "ask" });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    await act(async () => {
      result.current.preview.handleRetryFile(0);
    });
    expect(generateS3UploadUrlAction).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "agent" }),
    );
    expect(result.current.uploadedFiles[0].uploaded).toBe(true);
  });

  it("aborts in-flight requests on unmount", async () => {
    let signal!: AbortSignal;
    (global.fetch as jest.Mock).mockImplementation((_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const { result, unmount } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
