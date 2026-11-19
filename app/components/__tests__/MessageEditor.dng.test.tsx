import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageEditor } from "../MessageEditor";

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ subscription: "pro" }),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ alt, src }: { alt: string; src: string }) => {
    const React = require("react");
    return React.createElement("img", { alt, src });
  },
}));

it("keeps a DNG original as a removable file card beside an image thumbnail", () => {
  render(
    <MessageEditor
      initialContent="Compare these"
      initialFiles={[
        {
          fileId: "dng-1",
          name: "camera-original.dng",
          mediaType: "image/x-adobe-dng",
          url: "https://files.example/camera-original.dng",
        },
        {
          fileId: "png-1",
          name: "screenshot.png",
          mediaType: "image/png",
          url: "https://files.example/screenshot.png",
        },
      ]}
      onSave={jest.fn()}
      onCancel={jest.fn()}
    />,
  );

  expect(screen.getByText("camera-original.dng")).toBeInTheDocument();
  expect(screen.queryByAltText("camera-original.dng")).not.toBeInTheDocument();
  expect(screen.getByAltText("screenshot.png")).toHaveAttribute(
    "src",
    "https://files.example/screenshot.png",
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Remove camera-original.dng" }),
  );
  expect(screen.queryByText("camera-original.dng")).not.toBeInTheDocument();
  expect(screen.getByAltText("screenshot.png")).toBeInTheDocument();
});
