import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocalFilePreviewCard } from "../LocalFilePreviewCard";
import {
  getLocalFileMetadata,
  pickLocalFiles,
  readLocalPreviewFile,
} from "@/app/hooks/useTauri";
import { toast } from "sonner";

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => true,
  pickLocalFiles: jest.fn(),
  getLocalFileMetadata: jest.fn(),
  readLocalPreviewFile: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn(), info: jest.fn() } }));

beforeEach(() => jest.clearAllMocks());

it("reopens a saved local attachment through the picker and actual preview component", async () => {
  jest.mocked(pickLocalFiles).mockResolvedValue(["/local/notes.txt"]);
  jest.mocked(getLocalFileMetadata).mockResolvedValue({
    path: "/local/notes.txt",
    name: "notes.txt",
    mediaType: "text/plain",
    size: 12,
    lastModified: 0,
  });
  const file = new File(["saved local text"], "notes.txt", {
    type: "text/plain",
  });
  Object.defineProperty(file, "slice", {
    value: () => ({ text: async () => "saved local text" }),
  });
  jest.mocked(readLocalPreviewFile).mockResolvedValue(file);
  render(<LocalFilePreviewCard fileName="notes.txt" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Locate notes.txt to preview" }),
  );
  expect(await screen.findByText("saved local text")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close file preview" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not read a differently named file selected for a saved attachment", async () => {
  jest.mocked(pickLocalFiles).mockResolvedValue(["/local/wrong.txt"]);
  jest.mocked(getLocalFileMetadata).mockResolvedValue({
    path: "/local/wrong.txt",
    name: "wrong.txt",
    mediaType: "text/plain",
    size: 12,
    lastModified: 0,
  });
  render(<LocalFilePreviewCard fileName="notes.txt" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Locate notes.txt to preview" }),
  );
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Select notes.txt to preview this attachment.",
    ),
  );
  expect(readLocalPreviewFile).not.toHaveBeenCalled();
});

it("leaves the saved attachment usable after cancelling the picker", async () => {
  jest.mocked(pickLocalFiles).mockResolvedValue([]);
  render(<LocalFilePreviewCard fileName="notes.txt" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Locate notes.txt to preview" }),
  );
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  expect(getLocalFileMetadata).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
