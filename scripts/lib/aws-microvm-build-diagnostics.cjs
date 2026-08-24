async function listMicrovmBuildDiagnostics({
  imageIdentifier,
  imageVersion,
  listPage,
}) {
  const builds = [];
  let nextToken;

  do {
    const response = await listPage({
      imageIdentifier,
      imageVersion,
      maxResults: 25,
      nextToken,
    });
    builds.push(
      ...(response.items || []).map((build) => ({
        build_id: build.buildId,
        build_state: build.buildState,
        architecture: build.architecture,
        state_reason: build.stateReason?.trim() || null,
      })),
    );
    nextToken = response.nextToken;
  } while (nextToken);

  const stateReason = builds.find(
    (build) =>
      build.build_state === "FAILED" &&
      build.architecture === "ARM_64" &&
      build.state_reason,
  )?.state_reason;
  return { builds, stateReason: stateReason || null };
}

module.exports = { listMicrovmBuildDiagnostics };
