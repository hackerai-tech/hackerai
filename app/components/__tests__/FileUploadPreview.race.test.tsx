import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { FileUploadPreview } from "../FileUploadPreview";
import { fileToBase64 } from "@/lib/utils/file-utils";

jest.mock("@/lib/utils/file-utils", () => ({
  ...jest.requireActual("@/lib/utils/file-utils"),
  fileToBase64: jest.fn(),
}));

it("keeps the current attachment visible when an older image read finishes", async () => {
  let completeOldRead!: (value: string) => void;
  jest.mocked(fileToBase64).mockReturnValueOnce(
    new Promise((resolve) => {
      completeOldRead = resolve;
    }),
  );
  const oldFile = new File(["image fixture"], "old.png", { type: "image/png" });
  const currentFile = new File(["current"], "current.txt", {
    type: "text/plain",
  });
  const onRemoveFile = jest.fn();
  const { rerender } = render(
    <FileUploadPreview
      uploadedFiles={[{ file: oldFile, uploading: true, uploaded: false }]}
      onRemoveFile={onRemoveFile}
    />,
  );
  rerender(
    <FileUploadPreview
      uploadedFiles={[{ file: currentFile, uploading: false, uploaded: true }]}
      onRemoveFile={onRemoveFile}
    />,
  );
  expect(screen.getByText("current.txt")).toBeInTheDocument();

  await act(async () => completeOldRead("data:image/png;base64,aW1hZ2U="));

  expect(screen.getByText("current.txt")).toBeInTheDocument();
});
