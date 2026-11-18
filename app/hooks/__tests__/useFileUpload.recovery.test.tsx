import { act, renderHook } from "@testing-library/react";
import {
  createContext,
  useContext,
  useCallback,
  useRef,
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
  // Like GlobalState, writes are visible to getUploadedFiles before React
  // renders, so admission can read live occupancy.
  const uploadedFilesRef = useRef<UploadedFileState[]>([]);
  const getUploadedFiles = useCallback(() => uploadedFilesRef.current, []);
  const setUploadedFiles = useCallback(
    (update: (files: UploadedFileState[]) => UploadedFileState[]) => {
      uploadedFilesRef.current = update(uploadedFilesRef.current);
      setUploadedFilesState(uploadedFilesRef.current);
    },
    [],
  );
  const navigationRevisionRef = useRef(0);
  const getChatNavigationRevision = useCallback(
    () => navigationRevisionRef.current,
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
    getChatNavigationRevision,
    clear: () => setUploadedFiles(() => []),
    // Mirrors chat navigation: the revision advances and the composer resets.
    navigate: () => {
      navigationRevisionRef.current += 1;
      setUploadedFiles(() => []);
    },
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
    navigate: globalState.navigate as () => void,
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

  describe("overlapping selections", () => {
    const image = (name: string) =>
      new File(["image attachment"], name, { type: "image/png" });
    const paste = (file: File) =>
      ({
        clipboardData: {
          getData: () => "",
          items: [{ kind: "file", getAsFile: () => file }],
        },
        preventDefault: jest.fn(),
      }) as unknown as ClipboardEvent;
    const names = (files: UploadedFileState[]) =>
      files.map(({ file }) => file.name);
    const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(
      globalThis,
      "createImageBitmap",
    );
    let decodes: Map<
      string,
      { succeed: () => void; fail: (error: Error) => void }
    >;
    beforeEach(() => {
      decodes = new Map();
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: (image: File) =>
          new Promise((resolve, reject) => {
            decodes.set(image.name, {
              succeed: () => resolve({ close() {} }),
              fail: reject,
            });
          }),
      });
    });
    afterEach(() => {
      if (originalCreateImageBitmap) {
        Object.defineProperty(
          globalThis,
          "createImageBitmap",
          originalCreateImageBitmap,
        );
      } else {
        Reflect.deleteProperty(globalThis, "createImageBitmap");
      }
    });

    it("keeps overlapping image pastes in user order when the second image decodes first", async () => {
      const { result } = renderHook(() => useHarness(), {
        wrapper: HarnessProvider,
      });
      const pending: Promise<boolean>[] = [];
      await act(async () => {
        pending.push(
          result.current.picker.handlePasteEvent(paste(image("first.png"))),
        );
        pending.push(
          result.current.preview.handlePasteEvent(paste(image("second.png"))),
        );
      });
      expect([...decodes.keys()]).toEqual(["first.png", "second.png"]);
      await act(async () => {
        decodes.get("second.png")?.succeed();
      });
      expect(result.current.uploadedFiles).toHaveLength(0);
      await act(async () => {
        decodes.get("first.png")?.succeed();
        await Promise.all(pending);
      });
      expect(names(result.current.uploadedFiles)).toEqual([
        "first.png",
        "second.png",
      ]);
    });

    it("reports an invalid earlier image without holding back the next selection", async () => {
      const { toast } = jest.requireMock("sonner");
      const { result } = renderHook(() => useHarness(), {
        wrapper: HarnessProvider,
      });
      const pending: Promise<boolean>[] = [];
      await act(async () => {
        pending.push(
          result.current.picker.handlePasteEvent(paste(image("broken.png"))),
        );
        pending.push(
          result.current.preview.handlePasteEvent(paste(image("second.png"))),
        );
      });
      await act(async () => {
        decodes.get("second.png")?.succeed();
        decodes.get("broken.png")?.fail(new Error("bad pixels"));
        await Promise.all(pending);
      });
      expect(names(result.current.uploadedFiles)).toEqual(["second.png"]);
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("broken.png: Image validation failed"),
      );
    });

    it.each(["sidebar", "history"])(
      "drops the old selection after %s navigation without delaying the next chat",
      async (navigation) => {
        const initialPath = window.location.pathname;
        try {
          const { result } = renderHook(() => useHarness(), {
            wrapper: HarnessProvider,
          });
          let previousChat!: Promise<boolean>;
          let currentChat!: Promise<boolean>;
          await act(async () => {
            previousChat = result.current.picker.handlePasteEvent(
              paste(image("previous-chat.png")),
            );
          });
          act(() => {
            if (navigation === "sidebar") {
              result.current.navigate();
            } else {
              window.history.replaceState({}, "", "/c/opened-from-history");
            }
          });
          await act(async () => {
            currentChat = result.current.preview.handlePasteEvent(
              paste(image("current-chat.png")),
            );
          });
          await act(async () => {
            decodes.get("current-chat.png")?.succeed();
            await currentChat;
          });
          expect(names(result.current.uploadedFiles)).toEqual([
            "current-chat.png",
          ]);
          await act(async () => {
            decodes.get("previous-chat.png")?.succeed();
            await previousChat;
          });
          expect(names(result.current.uploadedFiles)).toEqual([
            "current-chat.png",
          ]);
          expect(generateS3UploadUrlAction).not.toHaveBeenCalledWith(
            expect.objectContaining({ fileName: "previous-chat.png" }),
          );
        } finally {
          window.history.replaceState({}, "", initialPath);
        }
      },
    );

    it("admits a later batch only into slots that remain at the cap", async () => {
      const { toast } = jest.requireMock("sonner");
      const { result } = renderHook(() => useHarness("ask"), {
        wrapper: HarnessProvider,
      });
      const batch = (prefix: string) =>
        Array.from({ length: 6 }, (_, index) => file(`${prefix}-${index}.txt`));
      await act(async () => {
        await Promise.all([
          result.current.picker.handleFileUploadEvent(select(batch("a"))),
          result.current.preview.handleFileUploadEvent(select(batch("b"))),
        ]);
      });
      expect(names(result.current.uploadedFiles)).toEqual([
        ...batch("a").map(({ name }) => name),
        ...batch("b")
          .slice(0, 4)
          .map(({ name }) => name),
      ]);
      expect(toast.error).toHaveBeenCalledWith(
        "Only 4 files were added. Maximum 10 files allowed.",
      );
    });
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
});
