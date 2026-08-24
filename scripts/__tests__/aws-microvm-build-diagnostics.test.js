const {
  listMicrovmBuildDiagnostics,
} = require("../lib/aws-microvm-build-diagnostics.cjs");

describe("AWS Lambda MicroVM build diagnostics", () => {
  test("follows pagination to find a failed ARM64 build reason", async () => {
    const listPage = jest
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            buildId: "successful-build",
            buildState: "SUCCESSFUL",
            architecture: "ARM_64",
            stateReason: "not the failure",
          },
        ],
        nextToken: "page-2",
      })
      .mockResolvedValueOnce({
        items: [
          {
            buildId: "failed-build",
            buildState: "FAILED",
            architecture: "ARM_64",
            stateReason: "container build timed out",
          },
        ],
      });

    const result = await listMicrovmBuildDiagnostics({
      imageIdentifier: "image-arn",
      imageVersion: "12.0",
      listPage,
    });

    expect(listPage).toHaveBeenNthCalledWith(1, {
      imageIdentifier: "image-arn",
      imageVersion: "12.0",
      maxResults: 25,
      nextToken: undefined,
    });
    expect(listPage).toHaveBeenNthCalledWith(2, {
      imageIdentifier: "image-arn",
      imageVersion: "12.0",
      maxResults: 25,
      nextToken: "page-2",
    });
    expect(result.stateReason).toBe("container build timed out");
    expect(result.builds).toHaveLength(2);
  });
});
