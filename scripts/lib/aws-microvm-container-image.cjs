const CONTAINER_IMAGE_DIGEST_PATTERN =
  /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

function resolveContainerBaseImage(value) {
  const image = value?.trim();
  if (!image || !CONTAINER_IMAGE_DIGEST_PATTERN.test(image)) {
    throw new Error(
      "AWS_LAMBDA_MICROVM_CONTAINER_BASE_IMAGE must be an immutable container image digest (for example, ghcr.io/hackerai-tech/hackerai-sandbox@sha256:...)",
    );
  }
  return image;
}

module.exports = { resolveContainerBaseImage };
