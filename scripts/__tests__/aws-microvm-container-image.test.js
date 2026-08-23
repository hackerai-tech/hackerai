const {
  resolveContainerBaseImage,
} = require("../lib/aws-microvm-container-image.cjs");

const digest = "0123456789abcdef".repeat(4);

describe("AWS Lambda MicroVM container base image", () => {
  test("accepts and trims an immutable registry digest", () => {
    expect(
      resolveContainerBaseImage(
        `  ghcr.io/hackerai-tech/hackerai-sandbox@sha256:${digest}  `,
      ),
    ).toBe(`ghcr.io/hackerai-tech/hackerai-sandbox@sha256:${digest}`);
  });

  test.each([
    undefined,
    "",
    "ghcr.io/hackerai-tech/hackerai-sandbox:latest",
    "ghcr.io/hackerai-tech/hackerai-sandbox@sha256:short",
    `ghcr.io/hackerai-tech/hackerai-sandbox@sha256:${digest}\nRUN id`,
  ])("rejects a mutable or invalid image reference: %p", (value) => {
    expect(() => resolveContainerBaseImage(value)).toThrow(
      "must be an immutable container image digest",
    );
  });
});
