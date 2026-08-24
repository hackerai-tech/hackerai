# AWS Lambda MicroVM cloud sandbox

This provider runs the HackerAI command server inside one isolated AWS Lambda
MicroVM per user. Trigger.dev connects directly to the VM through AWS's
authenticated WebSocket endpoint. AWS validates the short-lived, VM- and
port-scoped token before proxying traffic to guest port 9000; the token never
enters Convex, the guest bootstrap payload, or application logs.

The integration is ARM64-only because Lambda MicroVMs currently support
Graviton only. The image grants `ALL` guest OS capabilities so tools that need
raw sockets can run inside the VM. The AWS-managed authenticated endpoint uses
`ALL_INGRESS`; it is not an unauthenticated public listener. Outbound internet
access uses a regional VPC connector whose private subnet routes through a NAT
Gateway and retained Elastic IP. Replacing a MicroVM therefore does not change
the public source IPv4 address observed by an authorized target.

## 1. Provision AWS prerequisites

HackerAI's curated catalog uses `us-east-1`, `us-west-2`, and `eu-west-1`.
Deploy the primary stack first; it owns the account-wide GitHub OIDC provider:

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name hackerai-lambda-microvm \
  --template-file aws-lambda-microvm/cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

Read its outputs:

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name hackerai-lambda-microvm \
  --query 'Stacks[0].Outputs'
```

Save its `GitHubOidcProviderArn`, then deploy the same regional prerequisites
without trying to create duplicate account-wide OIDC providers:

```bash
OIDC_PROVIDER_ARN='<GitHubOidcProviderArn from us-east-1>'
for region in us-west-2 eu-west-1; do
  aws cloudformation deploy \
    --region "$region" \
    --stack-name hackerai-lambda-microvm \
    --template-file aws-lambda-microvm/cloudformation.yaml \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides ExistingGitHubOidcProviderArn="$OIDC_PROVIDER_ARN"
done
```

Each regional stack output includes `EgressNetworkConnectorArn` and
`EgressIpv4Address`. The Elastic IP has a CloudFormation retain policy so stack
deletion cannot silently release the address. If the stack is intentionally
removed, clean up the retained address separately only after every customer has
been notified and migrated.

Availability tradeoff: each region intentionally uses one NAT Gateway and one
Elastic IP in one Availability Zone. This keeps the published allowlist to one
stable IP per region and avoids doubling the fixed NAT cost. An outage of that
AZ can interrupt that region's connector and existing sessions; new sessions
can use the configured cross-region failover when the customer has allowlisted
all three regional IPs. Multi-AZ egress should be introduced separately if its
additional recurring cost and three extra customer-facing IPs are justified.

Attach `DeployerPolicyArn` to the CI/operator identity that publishes images.
Attach every regional `RuntimePolicyArn` to the AWS identity used by
Trigger.dev. The Vercel
Data Controls cleanup path also needs `GetMicrovm`, `ListMicrovms`, and
`TerminateMicrovm`; a separate cleanup-only policy is preferable once workload
identity is configured. Prefer role assumption in production; access keys can
be used for an initial test. Every regional release manifest entry must set
`ExecutionRoleArn` to the matching regional role ARN; Lambda assumes that
narrowly scoped role to write guest runtime logs to CloudWatch.

## 2. Build and publish the image

Set one region's CloudFormation outputs and region, then run:

```bash
export AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET='<ArtifactBucketName>'
export AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN='<BuildRoleArn>'
export AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN='<ExecutionRoleArn>'
export AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN='<EgressNetworkConnectorArn>'
export AWS_LAMBDA_MICROVM_EGRESS_IPV4='<EgressIpv4Address>'
export AWS_LAMBDA_MICROVM_CONTAINER_BASE_IMAGE='ghcr.io/hackerai-tech/hackerai-sandbox@sha256:<digest>'
export AWS_REGION=us-east-1
pnpm aws:microvm:deploy
```

The command builds `packages/local`, creates a Lambda-compatible zip under
`.artifacts/`, uploads it to S3, creates or updates the MicroVM image, waits for
the exact returned image version to become `SUCCESSFUL` and `ACTIVE`, and then
prints the region, exact image ID/version, execution role, connector ARN, and
reserved egress IPv4 address. Repeat with the matching outputs for `us-west-2`
and `eu-west-1`; S3 artifacts cannot be reused across regions.

During AWS image preparation, both lifecycle image hooks run a bounded,
credential-free working-set primer. It initializes the in-process transport and
command protocol, a real shell PTY, local DNS lookup libraries, and the startup
paths for `bash`, passwordless `sudo`, `nmap`, and `naabu`. Any required step
failure rejects image validation rather than publishing an incompletely primed
image; structured hook logs include per-step duration without bootstrap data.

If the image build fails, inspect the CloudWatch log group shown by the Lambda
MicroVM image. The heavyweight Kali and security-tool layer is built by GitHub
Actions on a native ARM64 runner only when the `docker/` tree changes, published
to GHCR, and pinned by digest in the small Lambda build artifact. The GHCR
package must remain public so AWS's image builder can pull it without a registry
credential. The Lambda-managed MicroVM base is selected separately by the
deployment script. Failed releases also list the per-architecture image build
states and reasons in the structured GitHub Actions log, even when the parent
image version omits its reason.

## 3. Deploy the backend schema first

Deploy the Convex schema and functions before selecting the provider in the app:

```bash
pnpm exec convex deploy
```

The Convex deployment must already contain `CONVEX_SERVICE_ROLE_KEY`. Existing
`CENTRIFUGO_WS_URL` and `CENTRIFUGO_TOKEN_SECRET` values remain necessary for
local/desktop sandboxes, but the AWS MicroVM command path does not use them.
The protected production release workflow performs this deployment
automatically; the manual command is only for a local/operator release.

## 4. Configure HackerAI runtimes

Set these server-side variables in Trigger.dev. Every Agent run executes in a
Trigger.dev worker, which is the only application runtime that launches or
reuses a MicroVM:

```dotenv
CLOUD_SANDBOX_PROVIDER=aws-lambda-microvm
AWS_LAMBDA_MICROVM_RELEASE_MANIFEST=<atomic JSON manifest produced by the release workflow>
AWS_ACCESS_KEY_ID=<runtime identity key for an initial test>
AWS_SECRET_ACCESS_KEY=<runtime identity secret for an initial test>
CONVEX_SERVICE_ROLE_KEY=<existing server role key>
NEXT_PUBLIC_CONVEX_URL=<existing Convex deployment URL>
```

Keep the existing `CENTRIFUGO_WS_URL` and `CENTRIFUGO_TOKEN_SECRET` in
Trigger.dev only if local/desktop sandbox connections are enabled. They are not
read while the selected provider is `aws-lambda-microvm`.

The Vercel route always pins a Trigger execution region. New AWS sessions map
`us-east-1` to `us-east-1`, `us-west-2` to `us-west-2`, and Trigger's
`eu-central-1` worker region to AWS Ireland (`eu-west-1`). Unknown geography
defaults explicitly to US East. A running or suspended sandbox remains pinned
to its persisted region and image until it ends; a later request never silently
migrates its memory, disk, or outbound source location. Neither Trigger.dev nor
Vercel needs `AWS_REGION` or `AWS_LAMBDA_MICROVM_REGION` at runtime.

For a new session only, a regional capacity failure can make one bounded
cross-region attempt. US East tries Oregon, Oregon tries US East, and Ireland
tries US East; if that preferred alternate is administratively disabled, the
remaining enabled region is selected instead. Eligible failures are AWS
throttling, quota, retryable internal/5xx responses, and retryable network
transport errors from `RunMicrovm`. Authentication, authorization, signature,
validation, image/role/connector configuration, and guest lifecycle-hook
failures never trigger regional failover. The original Convex session must be
durably closed and any known MicroVM must be confirmed terminated before the
alternate launch begins. A failed alternate is returned to the caller without
cascading to a third region. Because a transport error can mean AWS created the
VM but its response was lost, the launcher first replays the identical
idempotent request with the same client token. A recovered primary continues
normally; if reconciliation also fails, that acquisition fails closed instead
of risking a duplicate cross-region VM.

Vercel does not need the release manifest, image IDs, execution roles, or
WebSocket configuration. Its Data Controls route terminates persisted MicroVM
IDs in their recorded regions, so Vercel only needs the dedicated AWS runtime
credentials (authorized by all three regional runtime policies) and
`CONVEX_SERVICE_ROLE_KEY` for that cleanup operation.

### Durable user workspaces

MicroVM disk remains ephemeral and must never be the only copy of a project.
After the last active parent run or subagent finishes, the guest archives
`/home/user` and uploads it to one private, user-scoped `workspace.tar.gz`
object in the existing HackerAI S3 bucket before suspending the VM. A fresh
replacement checks that object and restores it before any Agent tool can use the
new VM. Near-lifetime replacement also snapshots before terminating the old VM.
While a VM is running, a guest-side checkpoint process refreshes the same object
every two minutes using a scoped eight-hour upload URL. This bounds data loss if
Trigger.dev reaches its hard task cutoff before normal Agent cleanup can run.

The archive keeps source files, dotfiles, and Git state, but excludes
rebuildable `node_modules`, pnpm/npm caches, and the general home cache. The S3
object remains available across AWS's automatic suspended-VM termination and
the four-hour maximum lifetime. Data Controls **Delete sandboxes** and account
deletion both remove the durable object. Presigned transfer URLs are generated
by service-key-authenticated Convex actions using the existing
`AWS_S3_ACCESS_KEY_ID`, `AWS_S3_SECRET_ACCESS_KEY`, `AWS_S3_REGION`, and
`AWS_S3_BUCKET_NAME` Convex environment variables; S3 credentials are never
placed inside the guest.

Optional controls:

- `AWS_LAMBDA_MICROVM_MAX_DURATION_SECONDS` defaults to Lambda's 28,800-second
  limit (8 hours).
- `AWS_LAMBDA_MICROVM_MIN_REMAINING_SECONDS` defaults to 7,500 (2 hours and 5
  minutes). A reused VM below that remaining lifetime is terminated and
  replaced before accepting another Agent run, so it cannot expire midway
  through the two-hour Trigger.dev task window.
- Ingress is fixed to AWS's `ALL_INGRESS` connector so Trigger.dev can use the
  AWS-authenticated WebSocket endpoint. Runtime auth tokens are minted for one
  MicroVM, expire after at most 60 minutes, and are restricted to guest port 9000. Port 8080 lifecycle hooks are never included in application tokens.
- Egress is fixed to the VPC connector stored in each regional release catalog
  entry. Every connector routes through that region's retained Elastic IP; one
  global connector ARN is intentionally not accepted.
- Lambda endpoint-idle suspension is intentionally hard-coded to five minutes,
  followed by termination after 30 suspended minutes. While a Trigger worker is
  using the sandbox, its WebSocket heartbeat counts as endpoint activity.
  Parent Agent cleanup also compare-clears the ending Trigger run, verifies that
  the user has no other active parent runs or subagents, and explicitly suspends
  the shared MicroVM. A suspend failure falls back to termination only after a
  workspace snapshot succeeds. If both snapshot and suspend fail, the VM is
  retained until the maximum-duration backstop rather than deleting the only
  project copy. Replacement cleanup and Data Controls termination remain
  additional safety boundaries.

Never expose these variables with a `NEXT_PUBLIC_` prefix. AWS endpoint tokens
are generated on demand by the Trigger.dev runtime, restricted to port 9000,
and never stored. The prescribed token appears only in the TLS-protected
WebSocket subprotocol during the AWS-authenticated upgrade.

## Automated image promotion

`.github/workflows/aws-lambda-microvm-release.yml` publishes a new image only
when MicroVM image inputs change on `main`, or when it is run manually. It first
derives a content-addressed tag from the `docker/` tree. An existing tag is
reused; a missing tag builds the heavyweight ARM64 sandbox once on a native ARM
runner and publishes it to GHCR. Every regional Lambda artifact then contains
only the agent layer and uses the exact resolved base digest. Normal agent-only
changes therefore avoid rebuilding Kali and the security toolchain. The
workflow does not float production to AWS's or GHCR's implicit latest version.
Use the manual `rebuild_base` input for an intentional toolchain refresh when
`docker/` is unchanged; that bypasses the registry and layer caches, publishes a
new digest behind the tree tag, and promotes only the newly resolved digest.

It then waits for the exact versions in all three regions, launches a
short-lived VM in each region, executes a real command through every
authenticated WebSocket, verifies `checkip.amazonaws.com` observes the
configured regional Elastic IP, and confirms termination. Only after every
matrix leg succeeds does it build one release manifest, upload and read back
that exact manifest in Trigger.dev production, and deploy the pinned worker. A
partial regional build can never become the active release. Vercel remains
unchanged and older AWS image versions remain available for rollback.

`AWS_LAMBDA_MICROVM_ENABLED_REGIONS` in the protected GitHub production
environment is the durable placement kill switch. Keep `us-east-1` present and
use a comma-separated subset such as `us-east-1,eu-west-1` to stop new Oregon
placements without re-enabling them during the next image release. Existing
sessions remain pinned to their persisted region.

The CloudFormation stack creates a GitHub OIDC release role, so GitHub Actions
does not need long-lived AWS access keys. Create a GitHub environment named
`aws-lambda-microvm-production`, restrict it to the `main` branch, and configure
these environment variables from the stack and project outputs:

```text
AWS_RELEASE_ROLE_ARN_US_EAST_1=<GitHubReleaseRoleArn from us-east-1>
AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET_US_EAST_1=<ArtifactBucketName>
AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN_US_EAST_1=<BuildRoleArn>
AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN_US_EAST_1=<ExecutionRoleArn>
AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN_US_EAST_1=<EgressNetworkConnectorArn>
AWS_LAMBDA_MICROVM_EGRESS_IPV4_US_EAST_1=<EgressIpv4Address>

AWS_RELEASE_ROLE_ARN_US_WEST_2=<GitHubReleaseRoleArn from us-west-2>
AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET_US_WEST_2=<ArtifactBucketName>
AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN_US_WEST_2=<BuildRoleArn>
AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN_US_WEST_2=<ExecutionRoleArn>
AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN_US_WEST_2=<EgressNetworkConnectorArn>
AWS_LAMBDA_MICROVM_EGRESS_IPV4_US_WEST_2=<EgressIpv4Address>

AWS_RELEASE_ROLE_ARN_EU_WEST_1=<GitHubReleaseRoleArn from eu-west-1>
AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET_EU_WEST_1=<ArtifactBucketName>
AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN_EU_WEST_1=<BuildRoleArn>
AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN_EU_WEST_1=<ExecutionRoleArn>
AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN_EU_WEST_1=<EgressNetworkConnectorArn>
AWS_LAMBDA_MICROVM_EGRESS_IPV4_EU_WEST_1=<EgressIpv4Address>

TRIGGER_PROJECT_ID=<Trigger.dev project ref>
```

The unsuffixed US East variable names remain accepted temporarily so an
existing production environment can migrate without a flag-day rename.

Add dedicated CI tokens as environment secrets:

```text
CONVEX_DEPLOY_KEY=<production Convex deploy key>
TRIGGER_ACCESS_TOKEN=<Trigger.dev personal access token allowed to deploy this project>
```

The workflow deploys the production Convex functions before publishing and
promoting the image, then synchronizes non-secret MicroVM release configuration
into Trigger.dev. The dedicated AWS runtime identity credentials and existing
Convex service key must already be configured directly in Trigger.dev;
local/desktop sandbox support also keeps its existing Centrifugo values there.
Vercel retains only the AWS credentials and Convex key required by Data
Controls cleanup. They are not copied through GitHub Actions.

## 5. Validate the paid-plan release

AWS Lambda MicroVMs are the default cloud sandbox for every paid plan. The
application continues to hard-gate Free users to local-only behavior, and
`CLOUD_SANDBOX_PROVIDER=e2b` remains the explicit emergency rollback.

Measure provider health with `cloud_sandbox_provider_selected`. It includes the
provider, transport (`aws_websocket` or `e2b_sdk`), subscription tier, Trigger
region, requested and effective AWS region, placement reason, release ID,
pinned image version, acquisition path, acquisition duration, create attempts,
and failover source/error/duration when applicable. Structured
`cloud_sandbox_region_failover_started`, `_succeeded`, and `_failed` events
record the requested, failed, and selected regions plus privacy-safe AWS error
classification and timing. Failed acquisitions emit
`cloud_sandbox_acquisition_failed` with the intended provider, failure stage,
duration, and privacy-safe error name. Compare the
`hackerai-agent_run` outcome and Trigger duration/cost fields by
`sandbox_provider` to verify AWS reliability and latency after releases. The
saved
[rollout dashboard](https://us.posthog.com/project/144137/dashboard/2005952)
tracks these guardrails and cost by provider.

The release guardrails are:

- successful Agent-run rate is no more than 3 percentage points below E2B;
- sandbox-acquisition success is no more than 2 percentage points below E2B;
- AWS p95 acquisition latency is no more than 3 seconds slower than E2B; and
- no AWS MicroVM remains running more than 2 minutes after the user's final
  parent run and validation subagent finish.

Review these guardrails after deployments and during reliability incidents. If
they fail, use the explicit E2B rollback while the AWS issue is investigated.

Use an internal paid account and select **Cloud** in Agent mode. Confirm the
first terminal command creates one MicroVM. After the Agent run ends, confirm
the MicroVM transitions to `SUSPENDED`; a later Agent command should resume and
reuse it. When two Agent runs for the same user overlap, finishing either one
must leave the MicroVM running until the final run and its subagents finish.
Then run the following only against systems you own or are authorized to test:

```bash
uname -m
id
getcap /usr/bin/ping 2>/dev/null || true
sudo -n true
nmap --version
naabu -version
tcpdump --version
curl --fail --silent --show-error https://checkip.amazonaws.com
```

The final command must print the `EgressIpv4Address` for the session's persisted
AWS region. Publish all three addresses as HackerAI Cloud Agent egress IPs so a
target owner can allowlist the full regional failover set once.

The packaged Lambda image automatically routes `naabu` hostname lookups through
the non-loopback resolver supplied by the MicroVM runtime. An explicit `-r`
resolver still takes precedence. The wrapper also disables the per-VM update
check because images are immutable; an explicit `-up` request still works.

The lifecycle process also hosts the direct command server in the snapshotted
Node process. Suspend, resume, termination, and unexpected guest restart are
serialized in-process; `/run` does not fork a second Node worker. The launcher
persists the MicroVM ID before opening the direct endpoint, so every failure
path can terminate using either the durable or locally held AWS identifier.

For network correctness, start known open and closed TCP/UDP listeners on a
separate controlled host. Verify `nc`, `nmap -sT`, `nmap -sS`, `naabu`, and a UDP
probe report the expected mix rather than every port as open. Also test ICMP,
`tcpdump`, an outbound callback/listener flow, command cancellation, PTY
interaction, file creation/download, and a second command after several
minutes.

Finally, use **Settings -> Data Controls -> Delete terminal sandbox** and verify
the MicroVM becomes `TERMINATED` in AWS. Check the
`cloud_sandbox_provider_selected`, `cloud_sandbox_acquisition_failed`, and
`hackerai-agent_run` PostHog events plus structured `cloud_sandbox_*` logs for
the test user.

## Rollback

To route production users to E2B, terminate existing AWS MicroVM sessions from
Data Controls or AWS, set `CLOUD_SANDBOX_PROVIDER=e2b` in Trigger.dev, and
redeploy it. Per-run AWS configuration or quota failures never silently retry
on E2B; they remain attributed to AWS so the failure-rate guardrail stays
honest.

## Known boundaries

- Lambda's authenticated inbound endpoint supports HTTP-family protocols,
  including HackerAI's direct WebSocket, but not arbitrary inbound TCP/UDP.
  Reverse-listener scenarios still require an external relay or a VPC design
  that supports the required callback path.
- The VPC egress connector must be validated with the capability suite; guest
  raw-socket capability alone does not prove that every network path has native
  semantics.
- The full HackerAI tool image requires the 4 GiB / 2 vCPU baseline so its
  build and runtime filesystem have 16 GB of disk. Current first-tier US
  pricing is roughly $0.252/hour while running, before burst compute,
  snapshots, and data transfer.
- AWS penetration-testing rules and the target owner's authorization still
  apply to traffic originating from the account.
