import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { FileUploadPreview } from "../FileUploadPreview";
import type { UploadedFileState } from "@/types/file";

const createGeneratedTextUpload = (
  content: string,
  id = "paste_1",
  name = "Pasted text.txt",
): UploadedFileState => ({
  file: new File([content], name, { type: "text/plain" }),
  uploading: false,
  uploaded: true,
  storage: "s3",
  fileId: `file_${id}`,
  url: "https://s3.example/download",
  tokens: 10,
  generatedTextAttachment: {
    id,
    content,
  },
});

describe("FileUploadPreview generated pasted text attachments", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders a compact Codex-style text-file card", () => {
    const onShowGeneratedTextInField = jest.fn();
    render(
      <FileUploadPreview
        uploadedFiles={[
          createGeneratedTextUpload(
            "First useful characters from the pasted source material.",
          ),
        ]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={jest.fn()}
        onShowGeneratedTextInField={onShowGeneratedTextInField}
      />,
    );

    expect(screen.getByText("Pasted text.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show in text field"));
    expect(onShowGeneratedTextInField).toHaveBeenCalledWith(
      0,
      "First useful characters from the pasted source material.",
    );
    expect(
      screen.queryByText(
        "First useful characters from the pasted source material.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Open Pasted text.txt")).toBeInTheDocument();
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

    fireEvent.click(screen.getByLabelText("Open Pasted text.txt"));
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

  it("shows target incompatibility and keeps inline restoration available", () => {
    const onShowGeneratedTextInField = jest.fn();

    const { rerender } = render(
      <FileUploadPreview
        uploadedFiles={[createGeneratedTextUpload("Pasted source material")]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={jest.fn()}
        onShowGeneratedTextInField={onShowGeneratedTextInField}
      />,
    );

    expect(screen.queryByText("Unavailable in Ask")).not.toBeInTheDocument();

    rerender(
      <FileUploadPreview
        uploadedFiles={[createGeneratedTextUpload("Pasted source material")]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={jest.fn()}
        onShowGeneratedTextInField={onShowGeneratedTextInField}
        generatedTextAttachmentsAvailable={false}
      />,
    );

    expect(screen.getByText("Unavailable in Ask")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show in text field"));
    expect(onShowGeneratedTextInField).toHaveBeenCalledWith(
      0,
      "Pasted source material",
    );
  });

  it("restores the latest editor content without waiting for autosave", () => {
    jest.useFakeTimers();
    const onShowGeneratedTextInField = jest.fn();
    const onUpdateGeneratedTextFile = jest.fn();

    render(
      <FileUploadPreview
        uploadedFiles={[createGeneratedTextUpload("Original pasted content")]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={onUpdateGeneratedTextFile}
        onShowGeneratedTextInField={onShowGeneratedTextInField}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open Pasted text.txt"));
    fireEvent.change(screen.getByLabelText("Pasted text content"), {
      target: { value: "Latest editor content" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Show in text field" }).at(-1)!,
    );

    expect(onShowGeneratedTextInField).toHaveBeenCalledWith(
      0,
      "Latest editor content",
    );
    expect(onUpdateGeneratedTextFile).not.toHaveBeenCalled();
    expect(
      screen.queryByLabelText("Pasted text content"),
    ).not.toBeInTheDocument();
  });

  it("keeps oversized pasted text editable without offering inline restoration", () => {
    render(
      <FileUploadPreview
        uploadedFiles={[createGeneratedTextUpload("A".repeat(25_001))]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={jest.fn()}
        onShowGeneratedTextInField={jest.fn()}
      />,
    );

    expect(screen.queryByText("Show in text field")).not.toBeInTheDocument();
    expect(screen.getByText("Click to edit")).toBeInTheDocument();
    expect(screen.getByLabelText("Open Pasted text.txt")).not.toBeDisabled();
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

    fireEvent.click(screen.getByLabelText("Open Pasted text.txt"));
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

    fireEvent.click(screen.getByLabelText("Open Pasted text.txt"));
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

  it("saves to the edited attachment after an earlier file is removed", () => {
    jest.useFakeTimers();
    const onUpdateGeneratedTextFile = jest.fn();
    const firstFile = createGeneratedTextUpload(
      "First pasted content",
      "paste_1",
      "Pasted text.txt",
    );
    const secondFile = createGeneratedTextUpload(
      "Second pasted content",
      "paste_2",
      "Pasted text 2.txt",
    );

    const { rerender } = render(
      <FileUploadPreview
        uploadedFiles={[firstFile, secondFile]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={onUpdateGeneratedTextFile}
      />,
    );

    fireEvent.click(screen.getByLabelText("Open Pasted text 2.txt"));
    fireEvent.change(screen.getByLabelText("Pasted text content"), {
      target: { value: "Updated second pasted content" },
    });

    rerender(
      <FileUploadPreview
        uploadedFiles={[secondFile]}
        onRemoveFile={jest.fn()}
        onUpdateGeneratedTextFile={onUpdateGeneratedTextFile}
      />,
    );

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(onUpdateGeneratedTextFile).toHaveBeenCalledWith(
      0,
      "Updated second pasted content",
    );
  });
});
