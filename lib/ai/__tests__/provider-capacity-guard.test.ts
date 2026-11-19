import { ChatSDKError } from "@/lib/errors";
import { withProviderCapacityCheck } from "../provider-capacity-guard";

it("rechecks the QA pool on each adapter attempt, even on the same model", async () => {
  const exhausted = new ChatSDKError(
    "rate_limit:chat",
    "QA spending cap reached",
    {
      capReason: "qa_spend_cap",
    },
  );
  const checkCapacity = jest
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(exhausted);
  const doStream = jest.fn().mockResolvedValue({
    stream: new ReadableStream({ start: (controller) => controller.close() }),
  });
  const doGenerate = jest.fn();
  const model = withProviderCapacityCheck(
    {
      specificationVersion: "v3",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doStream,
      doGenerate,
    },
    checkCapacity,
  );
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    throw new Error("Expected the wrapped test model");
  }

  await model.doStream({ prompt: [] });
  await expect(model.doStream({ prompt: [] })).rejects.toBe(exhausted);
  await expect(model.doGenerate({ prompt: [] })).rejects.toBe(exhausted);
  expect(checkCapacity).toHaveBeenCalledTimes(3);
  expect(doStream).toHaveBeenCalledTimes(1);
  expect(doGenerate).not.toHaveBeenCalled();
});
