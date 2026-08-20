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
access uses Lambda's managed `INTERNET_EGRESS` connector, or an explicitly
configured VPC connector.

## 1. Provision AWS prerequisites

Lambda MicroVM execution is currently fixed to `us-east-1`. Deploy the stack
there:

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

Attach `DeployerPolicyArn` to the CI/operator identity that publishes images.
Attach `RuntimePolicyArn` to the AWS identity used by Trigger.dev. The Vercel
Data Controls cleanup path also needs `GetMicrovm`, `ListMicrovms`, and
`TerminateMicrovm`; a separate cleanup-only policy is preferable once workload
identity is configured. Prefer role assumption in production; access keys can
be used for an initial test. Set `ExecutionRoleArn` as
`AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN`; Lambda assumes this narrowly scoped
role to write guest runtime logs to CloudWatch.

## 2. Build and publish the image

Set the two CloudFormation outputs, then run:

```bash
export AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET='<ArtifactBucketName>'
export AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN='<BuildRoleArn>'
pnpm aws:microvm:deploy
```

The command builds `packages/local`, creates a Lambda-compatible zip under
`.artifacts/`, uploads it to S3, creates or updates the MicroVM image, waits for
the exact returned image version to become `SUCCESSFUL` and `ACTIVE`, and then
prints `AWS_LAMBDA_MICROVM_IMAGE_ID` and
`AWS_LAMBDA_MICROVM_IMAGE_VERSION`.

During AWS image preparation, both lifecycle image hooks run a bounded,
credential-free working-set primer. It initializes the in-process transport and
command protocol, a real shell PTY, local DNS lookup libraries, and the startup
paths for `bash`, passwordless `sudo`, `nmap`, and `naabu`. Any required step
failure rejects image validation rather than publishing an incompletely primed
image; structured hook logs include per-step duration without bootstrap data.

If the image build fails, inspect the CloudWatch log group shown by the Lambda
MicroVM image. The HackerAI image currently uses Kali's public ARM64 container
base, while the Lambda-managed MicroVM base is selected separately by the
deployment script.

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
AWS_LAMBDA_MICROVM_IMAGE_ID=<image ARN printed by deploy>
AWS_LAMBDA_MICROVM_IMAGE_VERSION=<version printed by deploy>
AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<ExecutionRoleArn>
AWS_ACCESS_KEY_ID=<runtime identity key for an initial test>
AWS_SECRET_ACCESS_KEY=<runtime identity secret for an initial test>
CONVEX_SERVICE_ROLE_KEY=<existing server role key>
NEXT_PUBLIC_CONVEX_URL=<existing Convex deployment URL>
```

Keep the existing `CENTRIFUGO_WS_URL` and `CENTRIFUGO_TOKEN_SECRET` in
Trigger.dev only if local/desktop sandbox connections are enabled. They are not
read while the selected provider is `aws-lambda-microvm`.

The provider region is intentionally fixed in code to `us-east-1` until
multi-region image publication and routing are implemented. Vercel,
Trigger.dev, and local development do not need `AWS_REGION` or
`AWS_LAMBDA_MICROVM_REGION` for this provider.

Vercel does not need the image ID, image version, execution role, or WebSocket
configuration. Its Data Controls route terminates persisted MicroVM IDs
directly, so Vercel only needs the dedicated AWS runtime credentials and
`CONVEX_SERVICE_ROLE_KEY` for that cleanup operation.

Optional controls:

- `AWS_LAMBDA_MICROVM_MAX_DURATION_SECONDS` defaults to 14,400 (4 hours) and
  can be raised to Lambda's 28,800-second limit when a longer reuse window is
  worth the additional runaway-cost exposure.
- `AWS_LAMBDA_MICROVM_MIN_REMAINING_SECONDS` defaults to 7,500 (2 hours and 5
  minutes). A reused VM below that remaining lifetime is terminated and
  replaced before accepting another Agent run, so it cannot expire midway
  through the two-hour Trigger.dev task window.
- Ingress is fixed to AWS's `ALL_INGRESS` connector so Trigger.dev can use the
  AWS-authenticated WebSocket endpoint. Runtime auth tokens are minted for one
  MicroVM, expire after at most 60 minutes, and are restricted to guest port 9000. Port 8080 lifecycle hooks are never included in application tokens.
- `AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN` defaults to `INTERNET_EGRESS`.
- Lambda endpoint-idle suspension is intentionally hard-coded to five minutes,
  followed by termination after 30 suspended minutes. While a Trigger worker is
  using the sandbox, its WebSocket heartbeat counts as endpoint activity.
  Parent Agent cleanup also compare-clears the ending Trigger run, verifies that
  the user has no other active parent runs or subagents, and explicitly suspends
  the shared MicroVM. A suspend failure falls back to termination, while
  replacement cleanup, Data Controls termination, and the maximum-duration cap
  remain additional safety boundaries.

Never expose these variables with a `NEXT_PUBLIC_` prefix. AWS endpoint tokens
are generated on demand by the Trigger.dev runtime, restricted to port 9000,
and never stored. The prescribed token appears only in the TLS-protected
WebSocket subprotocol during the AWS-authenticated upgrade.

## Automated image promotion

`.github/workflows/aws-lambda-microvm-release.yml` publishes a new image only
when MicroVM image inputs change on `main`, or when it is run manually. It does
not float production to AWS's implicit latest version. Instead it waits for the
exact published version, launches a short-lived VM, executes a real command
through its authenticated WebSocket, terminates it, uploads and verifies that
exact version in Trigger.dev's stored production environment, pins it in a new
production worker, and leaves Vercel unchanged. Older AWS image versions remain
available for an explicit rollback. A failed Trigger.dev upload or read-back
verification stops the release before the worker deploys.

The CloudFormation stack creates a GitHub OIDC release role, so GitHub Actions
does not need long-lived AWS access keys. Create a GitHub environment named
`aws-lambda-microvm-production`, restrict it to the `main` branch, and configure
these environment variables from the stack and project outputs:

```text
AWS_RELEASE_ROLE_ARN=<GitHubReleaseRoleArn>
AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET=<ArtifactBucketName>
AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN=<BuildRoleArn>
AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<ExecutionRoleArn>
TRIGGER_PROJECT_ID=<Trigger.dev project ref>
```

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

## 5. Validate the paid-plan gradual rollout

Production assignment is controlled by the PostHog feature flag
[`aws_lambda_microvm_ultra_rollout_v1`](https://us.posthog.com/project/144137/feature_flags/828023).
The application hard-gates Free users to local-only behavior and evaluates the
flag for every paid plan. PostHog is the final AWS/E2B provider gate in every
environment, so use an explicit allowlist before widening percentage rollout;
paid users outside the enabled population stay on E2B as the concurrent
control.

Measure actual acquisition exposure with `cloud_sandbox_provider_selected`.
It includes the provider, transport (`aws_websocket` or `e2b_sdk`), rollout
variant, subscription tier, acquisition path, acquisition duration, create
attempts, and evaluated feature-flag value. Failed
acquisitions emit `cloud_sandbox_acquisition_failed` with the intended provider,
rollout variant, failure stage, duration, and privacy-safe error name. Compare
the `hackerai-agent_run` outcome and Trigger duration/cost fields by
`sandbox_provider` to verify that AWS is no worse than E2B on reliability and
latency before each ramp. The saved
[rollout dashboard](https://us.posthog.com/project/144137/dashboard/2005952)
tracks these guardrails and cost by provider.

The initial rollout guardrails are:

- successful Agent-run rate is no more than 3 percentage points below E2B;
- sandbox-acquisition success is no more than 2 percentage points below E2B;
- AWS p95 acquisition latency is no more than 3 seconds slower than E2B; and
- no AWS MicroVM remains running more than 2 minutes after the user's final
  parent run and validation subagent finish.

Review after at least 100 AWS exposures or seven days, whichever comes later.
If the guardrails hold, ramp Ultra targeting through 25%, 50%, then 100%, with
a fresh readout at every step. Keep non-Ultra plans on E2B until Ultra reaches
100% and the full-network capability test below is green.

Use an internal Ultra account and select **Cloud** in Agent mode. Confirm the
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
```

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

Disable `aws_lambda_microvm_ultra_rollout_v1` to route all production users to
E2B immediately. For the configuration-level kill switch, terminate existing
AWS MicroVM sessions from Data Controls or AWS, set
`CLOUD_SANDBOX_PROVIDER=e2b` in Trigger.dev, and redeploy it. Per-run AWS
configuration or quota failures never silently retry on E2B; they remain
attributed to the AWS rollout so the failure-rate guardrail stays honest.

## Known boundaries

- Lambda's authenticated inbound endpoint supports HTTP-family protocols,
  including HackerAI's direct WebSocket, but not arbitrary inbound TCP/UDP.
  Reverse-listener scenarios still require an external relay or a VPC design
  that supports the required callback path.
- The managed internet connector must be validated with the capability suite;
  guest raw-socket capability alone does not prove that every network path has
  native semantics.
- The full HackerAI tool image requires the 4 GiB / 2 vCPU baseline so its
  build and runtime filesystem have 16 GB of disk. Current first-tier US
  pricing is roughly $0.252/hour while running, before burst compute,
  snapshots, and data transfer.
- AWS penetration-testing rules and the target owner's authorization still
  apply to traffic originating from the account.
