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
import * as fileUtils from "@/lib/utils/file-utils";
import { useFileUpload } from "../useFileUpload";
import { UploadedFileState } from "@/types/file";
import { waitUnlessAborted } from "@/lib/utils/browser-file-upload";

let authState: { user: { id: string } | null; organizationId?: string };
type Reservation = {
  fileName: string;
  scope?: { userId: string; organizationId: string | null };
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
const mockStorageRegion = jest.fn<Promise<undefined>, []>();
jest.mock("@/lib/utils/file-utils", () => {
  const actual = jest.requireActual<typeof fileUtils>("@/lib/utils/file-utils");
  return { ...actual, validateImageFile: jest.fn(actual.validateImageFile) };
});
jest.mock("@/lib/storage/file-storage-region", () => ({
  getPreferredFileStorageRegion: () => mockStorageRegion(),
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
    ({
      fileName,
      expectedUploadScope,
    }: {
      fileName: string;
      expectedUploadScope?: Reservation["scope"];
    }) =>
      new Promise((resolve, reject) => {
        reservations.push({
          fileName,
          scope: expectedUploadScope,
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
const INTERRUPTED = {
  uploading: false,
  uploaded: false,
  retryable: false,
  error: "Upload interrupted. Remove and attach the file again.",
};
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
    mockStorageRegion.mockResolvedValue(undefined);
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

  it("sends reservations one at a time across hook owners while earlier transfers and saves run", async () => {
    deferReservations();
    const finishPuts: Array<(response: unknown) => void> = [];
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise((resolve) => finishPuts.push(resolve)),
    );
    const finishSaves: Array<() => void> = [];
    saveFile.mockImplementation(
      () =>
        new Promise((resolve) =>
          finishSaves.push(() =>
            resolve({ fileId: "saved-file", url: "url", tokens: 0 }),
          ),
        ),
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
    expect(reservations[0].scope).toEqual({
      userId: "user-a",
      organizationId: "org-a",
    });

    // The first PUT is still running; the next reservation does not wait.
    await act(async () => reservations[0].resolve());
    expect(putUrls()).toEqual(["https://s3.example/first.txt"]);
    expect(sentReservations()).toEqual(["first.txt", "second.txt"]);

    // Nor does it wait for the first metadata save.
    await act(async () => finishPuts[0]({ ok: true }));
    expect(saveFile).toHaveBeenCalledTimes(1);
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
    expect(finishSaves).toHaveLength(1);

    await act(async () => {
      reservations[2].resolve();
    });
    await act(async () => {
      finishPuts.forEach((finish) => finish({ ok: true }));
    });
    await act(async () => {
      finishSaves.forEach((finish) => finish());
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

    // A server-side scope mismatch is an interruption, not a failure toast.
    await act(async () =>
      reservations[1].reject(
        new ConvexError({
          code: "UPLOAD_CONTEXT_CHANGED",
          message: "Upload interrupted. Remove and attach the file again.",
        }),
      ),
    );
    expect(sentReservations()).toEqual([
      "first.txt",
      "second.txt",
      "third.txt",
    ]);
    expect(result.current.uploadedFiles[1]).toMatchObject(INTERRUPTED);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();

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
    [
      "organization",
      { user: { id: "user-a" }, organizationId: "org-b" },
      { userId: "user-a", organizationId: "org-b" },
    ],
    [
      "account",
      { user: { id: "user-b" }, organizationId: "org-a" },
      { userId: "user-b", organizationId: "org-a" },
    ],
    ["sign-out", { user: null }, undefined],
  ])(
    "stops old-scope work after a %s change while new-scope work proceeds",
    async (_change, nextAuth, nextScope) => {
      deferReservations();
      const { result, rerender } = renderHook(() => useHarness(), {
        wrapper: HarnessProvider,
      });
      await act(async () => {
        await result.current.picker.handleFileUploadEvent(
          select([file("first.txt"), file("second.txt"), file("third.txt")]),
        );
      });
      expect(reservations[0].scope).toEqual({
        userId: "user-a",
        organizationId: "org-a",
      });
      // A re-render for the same committed session keeps queued work.
      rerender();
      await tick();
      expect(result.current.uploadedFiles[1].uploading).toBe(true);

      authState = nextAuth;
      rerender();
      await tick();
      // The sent request's spinner clears while its presign is unresolved.
      expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);
      expect(result.current.uploadedFiles[1]).toMatchObject(INTERRUPTED);
      expect(result.current.uploadedFiles[2]).toMatchObject(INTERRUPTED);

      // New-scope work waits behind the request already sent.
      await act(async () => {
        await result.current.preview.handleFileUploadEvent(
          select([file("fourth.txt")]),
        );
      });
      expect(sentReservations()).toEqual(["first.txt"]);

      // The sent request settles without starting a PUT for the old scope.
      await act(async () => reservations[0].resolve());
      expect(putUrls()).toEqual([]);
      expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);
      expect(sentReservations()).toEqual(["first.txt", "fourth.txt"]);
      expect(reservations[1].scope).toEqual(nextScope);

      await act(async () => reservations[1].resolve());
      await tick(10_000);
      expect(sentReservations()).toEqual(["first.txt", "fourth.txt"]);
      expect(putUrls()).toEqual(["https://s3.example/fourth.txt"]);
      expect(saveFile).toHaveBeenCalledTimes(1);
      expect(result.current.uploadedFiles[3]).toMatchObject({
        uploaded: true,
      });
    },
  );

  it("aborts the active PUT when the sign-in scope changes", async () => {
    let putSignal!: AbortSignal;
    (global.fetch as jest.Mock).mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          putSignal = options.signal;
          putSignal.addEventListener("abort", () => reject(putSignal.reason), {
            once: true,
          });
        }),
    );
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    expect(putSignal.aborted).toBe(false);

    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    await tick();
    expect(putSignal.aborted).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(saveFile).not.toHaveBeenCalled();
    expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);
  });

  it("does not publish an old attachment when its save finishes after an account change", async () => {
    let finishSave!: (receipt: {
      url: string;
      fileId: string;
      tokens: number;
    }) => void;
    saveFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    expect(saveFile).toHaveBeenCalledTimes(1);

    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    await tick();
    // The spinner clears while the old-scope save is still pending.
    expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);

    await act(async () =>
      finishSave({
        url: "https://s3.example/saved",
        fileId: "old-account-file",
        tokens: 0,
      }),
    );
    expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);
    expect(result.current.uploadedFiles[0]?.fileId).toBeUndefined();
    // The old-scope file is preserved, not deleted from the new session.
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("treats a late rejection after an account change as an interruption", async () => {
    deferReservations();
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });

    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    await tick();
    expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);
    await act(async () => {
      await result.current.preview.handleFileUploadEvent(
        select([file("next.txt")]),
      );
    });
    expect(sentReservations()).toEqual(["report.txt"]);

    // The rejection after the wait stopped is consumed and frees the slot.
    await act(async () =>
      reservations[0].reject(
        new ConvexError({
          code: "FILE_UPLOAD_RATE_LIMIT",
          message: "Try again.",
        }),
      ),
    );
    expect(sentReservations()).toEqual(["report.txt", "next.txt"]);
    expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("restores the previous paste without its stopped spinner when a replacement fails", async () => {
    deferReservations();
    const { result } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    const original = "x".repeat(5000);
    await act(async () => {
      await result.current.picker.handlePastedTextAttachment(original);
    });
    expect(sentReservations()).toEqual(["Pasted text.txt"]);

    // Replacing the File stops the original transfer through the store; its
    // sent presign still holds the queue.
    await act(async () => {
      result.current.preview.handleUpdateGeneratedTextFile(0, "edited text");
    });
    await tick();
    expect(sentReservations()).toEqual(["Pasted text.txt"]);
    await act(async () => reservations[0].resolve());
    expect(sentReservations()).toHaveLength(2);

    await act(async () =>
      reservations[1].reject(
        new ConvexError({
          code: "STORAGE_LIMIT_EXCEEDED",
          message: "Storage limit exceeded.",
        }),
      ),
    );
    expect(result.current.uploadedFiles).toHaveLength(1);
    expect(result.current.uploadedFiles[0]).toMatchObject({
      uploading: false,
      uploaded: false,
      error: "Storage limit exceeded.",
      generatedTextAttachment: { content: original },
    });
    expect(putUrls()).toEqual([]);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("observes a late rejection and removes its listeners after a wait stops", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    const nextMacrotask = () =>
      new Promise((resolve) =>
        jest
          .requireActual<typeof import("timers")>("timers")
          .setImmediate(resolve),
      );
    try {
      const stopped = new AbortController();
      stopped.abort(new Error("stopped"));
      let rejectLate!: (error: unknown) => void;
      const late = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });
      await expect(waitUnlessAborted(late, [stopped.signal])).rejects.toBe(
        stopped.signal.reason,
      );
      rejectLate(new Error("late"));

      const live = new AbortController();
      const add = jest.spyOn(live.signal, "addEventListener");
      const remove = jest.spyOn(live.signal, "removeEventListener");
      await expect(
        waitUnlessAborted(Promise.resolve("done"), [live.signal]),
      ).resolves.toBe("done");
      expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);

      await nextMacrotask();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("clears the old spinner when an edit of an uploading pasted attachment is interrupted", async () => {
    deferReservations();
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    const original = "x".repeat(5000);
    await act(async () => {
      await result.current.picker.handlePastedTextAttachment(original);
    });
    expect(result.current.uploadedFiles[0].uploading).toBe(true);

    await act(async () => {
      result.current.preview.handleUpdateGeneratedTextFile(0, "edited text");
    });
    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    await tick();
    expect(result.current.uploadedFiles[0]).toMatchObject({
      ...INTERRUPTED,
      generatedTextAttachment: { content: original },
    });
    await act(async () => reservations[0].resolve());
    expect(generateS3UploadUrlAction).toHaveBeenCalledTimes(1);
  });

  it("discards a browser picker result from a previous sign-in scope", async () => {
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    const input = document.createElement("input");
    input.type = "file";
    result.current.picker.fileInputRef.current = input;
    const openPicker = jest.spyOn(input, "click").mockImplementation(() => {});
    act(() => result.current.picker.handleAttachClick());
    expect(openPicker).toHaveBeenCalledTimes(1);

    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("old.txt")]),
      );
    });
    expect(result.current.uploadedFiles).toEqual([]);
    expect(generateS3UploadUrlAction).not.toHaveBeenCalled();
  });

  it("discards a file selected before the account changes during validation", async () => {
    let finishImageValidation!: (result: { valid: boolean }) => void;
    const validateImage = jest
      .mocked(fileUtils.validateImageFile)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishImageValidation = resolve;
          }),
      );
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    const image = new File(["qa"], "selected.png", { type: "image/png" });
    let submit!: Promise<void>;
    await act(async () => {
      submit = result.current.picker.handleFileUploadEvent(select([image]));
    });
    expect(validateImage).toHaveBeenCalledWith(image);

    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    await act(async () => {
      finishImageValidation({ valid: true });
      await submit;
    });
    expect(result.current.uploadedFiles).toEqual([]);
    expect(generateS3UploadUrlAction).not.toHaveBeenCalled();
  });

  it("does not retry an old-scope reservation after the account changes", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("offline"));
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("report.txt")]),
      );
    });
    await tick(3000);
    expect(result.current.uploadedFiles[0].retryable).toBe(true);

    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    (global.fetch as jest.Mock).mockClear();
    await act(async () => {
      result.current.preview.handleRetryFile(0);
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);
  });

  it("stops waiting for a slow region lookup when its transfer or scope ends", async () => {
    deferReservations();
    let finishRegion!: (region: undefined) => void;
    mockStorageRegion.mockReturnValue(
      new Promise((resolve) => {
        finishRegion = resolve;
      }),
    );
    const { result, rerender } = renderHook(() => useHarness(), {
      wrapper: HarnessProvider,
    });
    await act(async () => {
      await result.current.picker.handleFileUploadEvent(
        select([file("first.txt"), file("second.txt")]),
      );
    });
    // Both share the hook's single region lookup.
    expect(mockStorageRegion).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.preview.handleRemoveFile(0);
    });
    authState = { user: { id: "user-b" }, organizationId: "org-a" };
    rerender();
    await tick();
    // Interrupted while the lookup is still pending.
    expect(result.current.uploadedFiles).toHaveLength(1);
    expect(result.current.uploadedFiles[0]).toMatchObject(INTERRUPTED);

    await act(async () => finishRegion(undefined));
    await tick(10_000);
    expect(sentReservations()).toEqual([]);
  });
});
