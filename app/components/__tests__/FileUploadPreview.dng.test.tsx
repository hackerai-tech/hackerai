import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileUploadPreview } from "../FileUploadPreview";
import { fileToBase64 } from "@/lib/utils/file-utils";

jest.mock("@/lib/utils/file-utils", () => ({
  ...jest.requireActual("@/lib/utils/file-utils"),
  fileToBase64: jest.fn(),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, src }: { alt: string; src: string }) => {
    const React = require("react");
    return React.createElement("img", { alt, src });
  },
}));

it("shows a DNG original as a named file card while a neighboring PNG keeps its thumbnail", async () => {
  jest.mocked(fileToBase64).mockResolvedValue("data:image/png;base64,aW1hZ2U=");
  const original = new File(["raw sensor bytes"], "camera-original.dng", {
    type: "image/x-adobe-dng",
  });
  const screenshot = new File(["png bytes"], "screenshot.png", {
    type: "image/png",
  });
  const onRemoveFile = jest.fn();

  render(
    <FileUploadPreview
      uploadedFiles={[
        { file: original, uploading: false, uploaded: true, fileId: "dng-1" },
        { file: screenshot, uploading: false, uploaded: true, fileId: "png-1" },
      ]}
      onRemoveFile={onRemoveFile}
    />,
  );

  expect(await screen.findByAltText("screenshot.png")).toHaveAttribute(
    "src",
    "data:image/png;base64,aW1hZ2U=",
  );
  expect(
    screen.getByRole("button", { name: "View camera-original.dng" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/^Document • /)).toBeInTheDocument();
  expect(screen.queryByAltText("camera-original.dng")).not.toBeInTheDocument();
  expect(fileToBase64).toHaveBeenCalledTimes(1);
  expect(fileToBase64).toHaveBeenCalledWith(screenshot);

  fireEvent.click(screen.getAllByRole("button", { name: "Remove file" })[0]);
  expect(onRemoveFile).toHaveBeenCalledWith(0);
});
