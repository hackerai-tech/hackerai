import { renderHook } from "@testing-library/react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { useDeletionConfirmation } from "../useDeletionConfirmation";

jest.mock("sonner", () => ({
  toast: { loading: jest.fn(() => "progress"), dismiss: jest.fn() },
}));
it("keeps reporting deletion after its originating sidebar row unmounts", async () => {
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  (useConvex().query as jest.Mock).mockReturnValue(pending);
  const { result, unmount } = renderHook(() => useDeletionConfirmation());
  const operation = result.current(async () => {}, { chatId: "chat-1" });
  await Promise.resolve();
  unmount();
  expect(toast.loading).toHaveBeenCalled();
  expect(toast.dismiss).not.toHaveBeenCalled();
  finish("complete");
  await operation;
  expect(toast.dismiss).toHaveBeenCalledWith("progress");
});
