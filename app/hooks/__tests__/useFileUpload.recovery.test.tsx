import { act, renderHook } from "@testing-library/react";
import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { useFileUpload } from "../useFileUpload";
import { UploadedFileState } from "@/types/file";

let authState: { user: { id: string } | null; organizationId?: string };
type Reservation = {
  fileName: string;
  resolve: () => void;
  reject: (error: unknown) => void;
};
let reservations: Reservation[] = [];
const deleteFile = jest.fn().mockResolvedValue(undefined);
const saveFile = jest.fn();
const generateS3UploadUrlAction = jest.fn();
const StateContext = createContext<any>(null);
jest.mock("convex/react", () => ({
  useConvex: () => ({ query: jest.fn().mockResolvedValue("complete") }),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
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
  const [uploadedFiles, setUploadedFilesState] = useState<UploadedFileState[]>(
    [],
  );
  // Like GlobalState, membership changes are readable before React renders.
  const uploadedFilesRef = useRef<UploadedFileState[]>([]);
  const getUploadedFiles = useCallback(() => uploadedFilesRef.current, []);
  const setUploadedFiles = useCallback(
    (
      update:
        | UploadedFileState[]
        | ((files: UploadedFileState[]) => UploadedFileState[]),
    ) => {
      uploadedFilesRef.current =
        typeof update === "function"
          ? update(uploadedFilesRef.current)
          : update;
      setUploadedFilesState(uploadedFilesRef.current);
    },
    [],
  );
  const addUploadedFile = useCallback(
    (file: UploadedFileState) => setUploadedFiles((prev) => [...prev, file]),
    [setUploadedFiles],
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
    [setUploadedFiles],
  );
  const removeUploadedFile = useCallback(
    (target: number | UploadedFileState["file"]) =>
      setUploadedFiles((prev) =>
        prev.filter((file, index) =>
          typeof target === "number" ? index !== target : file.file !== target,
        ),
      ),
    [setUploadedFiles],
  );
  const globalState = {
    uploadedFiles,
    getUploadedFiles,
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
// Holds every sent reservation until the test settles it.
const deferReservations = () => {
  generateS3UploadUrlAction.mockImplementation(
    ({ fileName }: { fileName: string }) =>
      new Promise((resolve, reject) => {
        reservations.push({
          fileName,
          resolve: () =>
            resolve({
              uploadUrl: `https://s3.example/${fileName}`,
              s3Key: `users/test/${fileName}`,
            }),
          reject,
        });
      }),
  );
};
const sentReservations = () => reservations.map((item) => item.fileName);
const putUrls = () =>
  (global.fetch as jest.Mock).mock.calls.map(([url]) => url as string);

describe("browser attachment recovery", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    authState = { user: { id: "user-a" }, organizationId: "org-a" };
    // A fresh object per render, as AuthKit may return for the same session.
    jest
      .mocked(useAuth)
      .mockImplementation(
        () => ({ ...authState }) as unknown as ReturnType<typeof useAuth>,
      );
    reservations = [];
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
  afterEach(async () => {
    // The reservation queue is page-wide; settle each sent request once so
    // the next test starts with an idle queue.
    for (let index = 0; index < reservations.length; index += 1) {
      await act(async () => reservations[index].resolve());
    }
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

  it("keeps a replacement running when deleting its previous stored file fails", async () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handlePastedTextAttachment("x".repeat(5000));
    });
    let finish!: (response: unknown) => void;
    let signal!: AbortSignal;
    (global.fetch as jest.Mock).mockImplementationOnce((_url, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    saveFile.mockResolvedValueOnce({
      fileId: "replacement",
      url: "url",
      tokens: 0,
    });
    await act(async () => {
      result.current.preview.handleUpdateGeneratedTextFile(
        0,
        "replacement content",
      );
    });
    deleteFile.mockRejectedValueOnce(new Error("Deletion unavailable"));
    await act(async () => {
      await result.current.preview.handleRemoveFile(0);
    });
    expect(signal.aborted).toBe(false);
    expect(result.current.uploadedFiles[0].removing).toBe(false);
    await act(async () => {
      finish({ ok: true });
    });
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploaded: true,
      uploading: false,
      fileId: "replacement",
      generatedTextAttachment: { content: "replacement content" },
    });
  });

  it("deletes a replacement that finishes while removal waits for the previous file", async () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handlePastedTextAttachment("x".repeat(5000));
    });
    let finishPut!: (response: unknown) => void;
    let finishDelete!: () => void;
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPut = resolve;
        }),
    );
    saveFile.mockResolvedValueOnce({
      fileId: "replacement",
      url: "url",
      tokens: 0,
    });
    await act(async () => {
      result.current.preview.handleUpdateGeneratedTextFile(
        0,
        "replacement content",
      );
    });
    deleteFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    let removal!: Promise<void>;
    act(() => {
      removal = result.current.preview.handleRemoveFile(0);
    });
    expect(result.current.uploadedFiles[0].removing).toBe(true);
    await act(async () => {
      finishPut({ ok: true });
    });
    expect(result.current.uploadedFiles[0].fileId).toBe("replacement");
    expect(result.current.uploadedFiles[0].removing).toBe(true);
    await act(async () => {
      finishDelete();
      await removal;
    });
    expect(deleteFile).toHaveBeenCalledWith({ fileId: "replacement" });
    expect(result.current.uploadedFiles).toHaveLength(0);
  });

  it("removes the restored attachment if its replacement fails during deletion", async () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handlePastedTextAttachment("x".repeat(5000));
    });
    let finishPut!: (response: unknown) => void;
    let finishDelete!: () => void;
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPut = resolve;
        }),
    );
    await act(async () => {
      result.current.preview.handleUpdateGeneratedTextFile(
        0,
        "replacement content",
      );
    });
    deleteFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    let removal!: Promise<void>;
    act(() => {
      removal = result.current.preview.handleRemoveFile(0);
    });
    await act(async () => {
      finishPut({ ok: false, status: 403 });
    });
    expect(
      result.current.uploadedFiles[0].generatedTextAttachment?.content,
    ).toBe("x".repeat(5000));
    await act(async () => {
      finishDelete();
      await removal;
    });
    expect(result.current.uploadedFiles).toHaveLength(0);
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

  it("sends reservations one at a time across hook owners while earlier transfers run", async () => {
    deferReservations();
    const finishPuts: Array<(response: unknown) => void> = [];
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise((resolve) => finishPuts.push(resolve)),
    );
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("first.txt"), file("second.txt")]),
      );
      await result.current.preview.handleFileUploadEvent(
        select([file("third.txt")]),
      );
    });
    expect(sentReservations()).toEqual(["first.txt"]);

    await act(async () => reservations[0].resolve());
    expect(putUrls()).toEqual(["https://s3.example/first.txt"]);
    expect(sentReservations()).toEqual(["first.txt", "second.txt"]);

    // The first transfer is still running; the next reservation does not wait.
    await act(async () => reservations[1].resolve());
    expect(putUrls()).toEqual([
      "https://s3.example/first.txt",
      "https://s3.example/second.txt",
    ]);
    expect(sentReservations()).toEqual([
      "first.txt",
      "second.txt",
      "third.txt",
    ]);

    await act(async () => {
      reservations[2].resolve();
    });
    await act(async () => {
      finishPuts.forEach((finish) => finish({ ok: true }));
    });
    expect(saveFile).toHaveBeenCalledTimes(3);
    expect(result.current.uploadedFiles.map((item) => item.uploaded)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("never sends a waiting reservation after removal or unmount", async () => {
    deferReservations();
    const { result, unmount } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([
          file("first.txt"),
          file("second.txt"),
          file("third.txt"),
          file("fourth.txt"),
        ]),
      );
    });
    await act(async () => {
      await result.current.preview.handleRemoveFile(1);
    });
    expect(result.current.uploadedFiles.map((item) => item.file.name)).toEqual([
      "first.txt",
      "third.txt",
      "fourth.txt",
    ]);

    // The removed waiter holds no place; the next live waiter goes directly.
    await act(async () => reservations[0].resolve());
    expect(sentReservations()).toEqual(["first.txt", "third.txt"]);

    unmount();
    await act(async () => reservations[1].resolve());
    await tick(10_000);
    expect(sentReservations()).toEqual(["first.txt", "third.txt"]);
  });

  it("keeps the slot for a sent reservation until it settles after removal", async () => {
    deferReservations();
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
    expect(sentReservations()).toEqual(["first.txt"]);

    await act(async () => reservations[0].resolve());
    expect(sentReservations()).toEqual(["first.txt", "second.txt"]);
    expect(putUrls()).not.toContain("https://s3.example/first.txt");

    await act(async () => reservations[1].resolve());
    expect(result.current.uploadedFiles).toHaveLength(1);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploaded: true,
      fileId: "saved-file",
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("advances once per rejected reservation and keeps ordinary error handling", async () => {
    deferReservations();
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("first.txt"), file("second.txt"), file("third.txt")]),
      );
    });
    await act(async () =>
      reservations[0].reject(
        new ConvexError({
          code: "STORAGE_LIMIT_EXCEEDED",
          message: "Storage limit exceeded.",
        }),
      ),
    );
    expect(sentReservations()).toEqual(["first.txt", "second.txt"]);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploading: false,
      uploaded: false,
      error: "Storage limit exceeded.",
    });
    expect(toast.error).toHaveBeenCalledWith("Storage limit exceeded.");
    expect(console.error).not.toHaveBeenCalled();

    await act(async () =>
      reservations[1].reject(new Error("Reservation unavailable")),
    );
    expect(sentReservations()).toEqual([
      "first.txt",
      "second.txt",
      "third.txt",
    ]);
    expect(result.current.uploadedFiles[1]).toMatchObject({
      uploading: false,
      uploaded: false,
      error: "Reservation unavailable",
    });

    await act(async () => reservations[2].resolve());
    expect(result.current.uploadedFiles[2]).toMatchObject({ uploaded: true });
  });

  it("never sends a waiting reservation cleared from the store before effects run", async () => {
    deferReservations();
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("first.txt"), file("second.txt")]),
      );
    });
    const { clear } = result.current;
    await act(async () => {
      // React publishes the clear only when this scope ends, so the running
      // reservation wakes the waiter while the hooks still hold old state.
      clear();
      reservations[0].resolve();
      for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();
    });
    await tick(10_000);
    expect(sentReservations()).toEqual(["first.txt"]);
    expect(result.current.uploadedFiles).toHaveLength(0);
  });

  it.each([
    ["organization", { user: { id: "user-a" }, organizationId: "org-b" }],
    ["account", { user: { id: "user-b" }, organizationId: "org-a" }],
    ["sign-out", { user: null }],
  ])(
    "discards reservations still waiting after a %s change",
    async (_change, nextAuth) => {
      deferReservations();
      const { result, rerender } = renderHook(() => useHarness(), {
        wrapper: HarnessProvider,
      });
      await act(async () => {
        await result.current.picker.handleFileUploadEvent(
          select([file("first.txt"), file("second.txt"), file("third.txt")]),
        );
      });
      // A re-render for the same committed session keeps queued work.
      rerender();
      await tick();
      expect(result.current.uploadedFiles[1].uploading).toBe(true);

      authState = nextAuth;
      rerender();
      await tick();
      const interrupted = {
        uploading: false,
        uploaded: false,
        retryable: false,
        error: "Upload interrupted. Remove and attach the file again.",
      };
      expect(result.current.uploadedFiles[1]).toMatchObject(interrupted);
      expect(result.current.uploadedFiles[2]).toMatchObject(interrupted);

      // The already-sent request completes; stale waiters are never sent.
      await act(async () => reservations[0].resolve());
      await tick(10_000);
      expect(sentReservations()).toEqual(["first.txt"]);
      expect(result.current.uploadedFiles[0]).toMatchObject({
        uploaded: true,
      });

      await act(async () => {
        await result.current.preview.handleFileUploadEvent(
          select([file("fourth.txt")]),
        );
      });
      expect(sentReservations()).toEqual(["first.txt", "fourth.txt"]);
      await act(async () => reservations[1].resolve());
      expect(result.current.uploadedFiles[3]).toMatchObject({
        uploaded: true,
      });
    },
  );
});
