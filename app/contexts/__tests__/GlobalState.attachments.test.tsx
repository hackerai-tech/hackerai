import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "@jest/globals";
import type { UploadedFileState } from "@/types/file";
import { GlobalStateProvider, useGlobalState } from "../GlobalState";

describe("attachment admission snapshots", () => {
  it("publishes accepted clears and subsequent edits before React renders", async () => {
    const { result } = renderHook(() => useGlobalState(), {
      wrapper: GlobalStateProvider,
    });
    const readFiles = result.current.getUploadedFiles;
    const file: UploadedFileState = {
      file: new File(["fixture"], "fixture.txt"),
      uploaded: true,
      uploading: false,
      fileId: "file-1",
    };
    await act(async () => {
      result.current.setUploadedFiles([file]);
      expect(readFiles()).toEqual([file]);
      result.current.clearUploadedFiles();
      expect(readFiles()).toEqual([]);
      result.current.addUploadedFile(file);
      result.current.updateUploadedFile(0, { tokens: 42 });
      expect(readFiles()[0].tokens).toBe(42);
      result.current.removeUploadedFile(file.file);
      expect(readFiles()).toEqual([]);
    });
    expect(result.current.uploadedFiles).toEqual([]);
  });
});
