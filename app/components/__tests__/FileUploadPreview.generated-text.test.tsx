import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { FileUploadPreview } from "../FileUploadPreview";
import type { UploadedFileState } from "@/types/file";

const createGeneratedTextUpload = (content: string): UploadedFileState => ({
  file: new File([content], "pasted_content.txt", { type: "text/plain" }),
  uploading: false,
  uploaded: true,
  storage: "s3",
  fileId: "file_123",
  url: "https://s3.example/download",
  tokens: 10,
  generatedTextAttachment: {
    id: "paste_1",
    content,
  },
});

describe("FileUploadPreview generated pasted text attachments", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders a compact text-file card with metadata", () => {
    render(
      <FileUploadPreview
        uploadedFiles={[
          createGeneratedTextUpload(
            "First useful characters from the pasted source material.",
          ),
        ]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={jest.fn()}
      />,
    );

    expect(screen.getByText("pasted_content.txt")).toBeInTheDocument();
    expect(screen.getByText(/^Text · /)).toBeInTheDocument();
    expect(screen.getByText("Click to edit")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "First useful characters from the pasted source material.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Open pasted_content.txt"),
    ).toBeInTheDocument();
  });

  it("opens an editor and auto-saves edited content", () => {
    jest.useFakeTimers();
    const onUpdateGeneratedTextFile = jest.fn();

    render(
      <FileUploadPreview
        uploadedFiles={[createGeneratedTextUpload("Original pasted content")]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={onUpdateGeneratedTextFile}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open pasted_content.txt"));
    const editor = screen.getByLabelText("Pasted text content");
    expect(editor).toHaveValue("Original pasted content");
    expect(
      screen.getByText("Changes save automatically as you edit"),
    ).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "Edited pasted content" } });
    expect(screen.getByText("Saving changes...")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(onUpdateGeneratedTextFile).toHaveBeenCalledWith(
      0,
      "Edited pasted content",
    );
  });

  it("flushes pending edits when the editor closes", () => {
    jest.useFakeTimers();
    const onUpdateGeneratedTextFile = jest.fn();

    render(
      <FileUploadPreview
        uploadedFiles={[createGeneratedTextUpload("Original pasted content")]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={onUpdateGeneratedTextFile}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open pasted_content.txt"));
    fireEvent.change(screen.getByLabelText("Pasted text content"), {
      target: { value: "Closed before debounce" },
    });

    fireEvent.click(screen.getByLabelText("Close pasted text editor"));

    expect(onUpdateGeneratedTextFile).toHaveBeenCalledWith(
      0,
      "Closed before debounce",
    );
  });

  it("flushes pending edits on unmount", () => {
    jest.useFakeTimers();
    const onUpdateGeneratedTextFile = jest.fn();

    const { unmount } = render(
      <FileUploadPreview
        uploadedFiles={[createGeneratedTextUpload("Original pasted content")]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={onUpdateGeneratedTextFile}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open pasted_content.txt"));
    fireEvent.change(screen.getByLabelText("Pasted text content"), {
      target: { value: "Unmounted before debounce" },
    });

    unmount();

    expect(onUpdateGeneratedTextFile).toHaveBeenCalledWith(
      0,
      "Unmounted before debounce",
    );
    expect(onUpdateGeneratedTextFile).toHaveBeenCalledTimes(1);

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(onUpdateGeneratedTextFile).toHaveBeenCalledTimes(1);
  });
});
