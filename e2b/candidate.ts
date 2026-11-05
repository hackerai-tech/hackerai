import { Template } from "e2b";
import { template } from "./template";

/** Build a new candidate without moving the template's default tag. */
export async function buildCandidate(
  target: string,
  tag: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!/^(us|eu)-(dev|prod)$/.test(target))
    throw new Error("Expected target: us-dev, eu-dev, us-prod, or eu-prod");
  if (!/^candidate-[a-z0-9][a-z0-9-]{0,63}$/.test(tag))
    throw new Error("Expected a unique candidate-* tag");

  const eu = target.startsWith("eu-");
  const apiKey = (eu ? env.E2B_EU_API_KEY : env.E2B_API_KEY)?.trim();
  if (!apiKey) throw new Error("The selected regional E2B key is required");
  const name = target.endsWith("-dev")
    ? "terminal-agent-sandbox-dev"
    : "terminal-agent-sandbox";
  // Do not silently use ambient SDK domain overrides for the US target.
  const domain = eu
    ? env.E2B_EU_DOMAIN?.trim() || "e2b-juliett.dev"
    : "e2b.dev";
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain))
    throw new Error("Expected a regional E2B hostname, without a URL or port");
  if (eu && env.E2B_EU_TEMPLATE?.trim() && env.E2B_EU_TEMPLATE.trim() !== name)
    throw new Error(
      "Custom EU template aliases require an explicit operator build",
    );
  const options = {
    apiKey,
    domain,
    // E2B_API_URL and E2B_DEBUG otherwise override the SDK's domain routing.
    apiUrl: `https://api.${domain}`,
    debug: false,
    retries: 0,
  };
  // Require an existing template so an incorrect project cannot silently seed
  // a new one. Account/project identity must still be verified by the operator.
  const lookupOptions = { ...options, requestTimeoutMs: 30_000 };
  const before = await Template.getTags(name, lookupOptions);
  const previousDefault = before.find(
    (item) => item.tag === "default",
  )?.buildId;
  if (!previousDefault || before.some((item) => item.tag === tag))
    throw new Error(
      "Template default is missing or the candidate tag already exists",
    );

  // E2B provisions envd when it builds the Docker filesystem. Do not install a
  // hand-picked envd binary into the image or assume an automatic-update floor.
  const build = await Template.build(template, `${name}:${tag}`, {
    ...options,
    // Keep SDK phase-specific defaults: its upload bound is longer than API
    // reads. A lookup timeout here would also abort Docker COPY uploads.
    skipCache: true,
    cpuCount: 4,
    memoryMB: 4096,
  });
  const after = await Template.getTags(build.templateId, lookupOptions);
  if (
    after.find((item) => item.tag === tag)?.buildId !== build.buildId ||
    after.find((item) => item.tag === "default")?.buildId !== previousDefault
  )
    throw new Error(
      "Tag readback mismatch; retain the build and inspect tags before proceeding",
    );

  return {
    target,
    domain,
    templateId: build.templateId,
    buildId: build.buildId,
    candidateTag: tag,
    previousDefaultBuildId: previousDefault,
    validationReference: `${build.templateId}:${build.buildId}`,
    envdVerification: "required_on_fresh_sandbox",
  };
}
