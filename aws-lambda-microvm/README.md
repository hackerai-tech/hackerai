# AWS Lambda MicroVM cloud sandbox

This provider runs the existing HackerAI command relay inside one isolated AWS
Lambda MicroVM per user. The web and Trigger.dev runtimes call the Lambda
MicroVM API; the guest connects outbound to Convex and Centrifugo, so HackerAI
does not expose a public command port.

The integration is ARM64-only because Lambda MicroVMs currently support
Graviton only. The image grants `ALL` guest OS capabilities so tools that need
raw sockets can run inside the VM. Inbound Lambda endpoints remain disabled by
default. Outbound internet access uses Lambda's managed `INTERNET_EGRESS`
connector, or an explicitly configured VPC connector.

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
Attach `RuntimePolicyArn` to the AWS identity used by both the HackerAI web
runtime and Trigger.dev. Prefer workload identity/role assumption in production;
access keys can be used for an initial test. Set `ExecutionRoleArn` as
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

If the image build fails, inspect the CloudWatch log group shown by the Lambda
MicroVM image. The HackerAI image currently uses Kali's public ARM64 container
base, while the Lambda-managed MicroVM base is selected separately by the
deployment script.

## 3. Deploy the backend schema first

Deploy the Convex schema and functions before selecting the provider in the app:

```bash
pnpm exec convex deploy
```

The Convex deployment must already contain the same `CENTRIFUGO_WS_URL`,
`CENTRIFUGO_TOKEN_SECRET`, and `CONVEX_SERVICE_ROLE_KEY` values used by the
current local/desktop relay.

## 4. Configure HackerAI runtimes

Set these server-side variables in both Vercel and Trigger.dev, then redeploy
both runtimes:

```dotenv
CLOUD_SANDBOX_PROVIDER=aws-lambda-microvm
AWS_LAMBDA_MICROVM_IMAGE_ID=<image ARN printed by deploy>
AWS_LAMBDA_MICROVM_IMAGE_VERSION=<version printed by deploy>
AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<ExecutionRoleArn>
AWS_ACCESS_KEY_ID=<runtime identity key for an initial test>
AWS_SECRET_ACCESS_KEY=<runtime identity secret for an initial test>
CONVEX_SERVICE_ROLE_KEY=<existing server role key>
NEXT_PUBLIC_CONVEX_URL=<existing Convex deployment URL>
CENTRIFUGO_WS_URL=<existing wss URL>
CENTRIFUGO_TOKEN_SECRET=<existing signing secret>
```

The provider region is intentionally fixed in code to `us-east-1` until
multi-region image publication and routing are implemented. Vercel,
Trigger.dev, and local development do not need `AWS_REGION` or
`AWS_LAMBDA_MICROVM_REGION` for this provider.

Optional controls:

- `AWS_LAMBDA_MICROVM_MAX_DURATION_SECONDS` defaults to 14,400 (4 hours) and
  can be raised to Lambda's 28,800-second limit when a longer reuse window is
  worth the additional runaway-cost exposure.
- `AWS_LAMBDA_MICROVM_MIN_REMAINING_SECONDS` defaults to 7,500 (2 hours and 5
  minutes). A reused VM below that remaining lifetime is terminated and
  replaced before accepting another Agent run, so it cannot expire midway
  through the two-hour Trigger.dev task window.
- Ingress is fixed to AWS's `NO_INGRESS` connector. The guest establishes the
  HackerAI relay outbound, so lifecycle hooks are never exposed as a public API.
- `AWS_LAMBDA_MICROVM_EGRESS_CONNECTOR_ARN` defaults to `INTERNET_EGRESS`.
- Lambda endpoint-idle suspension is intentionally not configurable. HackerAI
  uses `NO_INGRESS` and an outbound asynchronous relay, while Lambda measures
  idle time from inbound endpoint traffic. Enabling that policy could suspend a
  MicroVM while an Agent command is still active. Explicit termination,
  replacement cleanup, and the maximum-duration cap provide the lifecycle
  safety boundary instead.

Never expose these variables with a `NEXT_PUBLIC_` prefix. Bootstrap tokens are
generated per user session, stored only as SHA-256 hashes in Convex, scoped to a
single MicroVM/session, and expire after nine hours.

## Automated image promotion

`.github/workflows/aws-lambda-microvm-release.yml` publishes a new image only
when MicroVM image inputs change on `main`, or when it is run manually. It does
not float production to AWS's implicit latest version. Instead it waits for the
exact published version, launches and terminates a short-lived smoke-test VM,
pins that version in Vercel and Trigger.dev, and redeploys both runtimes. Older
AWS image versions remain available for an explicit rollback.

The CloudFormation stack creates a GitHub OIDC release role, so GitHub Actions
does not need long-lived AWS access keys. Create a GitHub environment named
`aws-lambda-microvm-production`, restrict it to the `main` branch, and configure
these environment variables from the stack and project outputs:

```text
AWS_RELEASE_ROLE_ARN=<GitHubReleaseRoleArn>
AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET=<ArtifactBucketName>
AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN=<BuildRoleArn>
AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=<ExecutionRoleArn>
VERCEL_ORG_ID=<Vercel team ID>
VERCEL_PROJECT_ID=<Vercel project ID>
TRIGGER_PROJECT_ID=<Trigger.dev project ref>
```

Add dedicated CI tokens as environment secrets:

```text
VERCEL_TOKEN=<Vercel token allowed to update and deploy this project>
TRIGGER_ACCESS_TOKEN=<Trigger.dev personal access token allowed to deploy this project>
```

The workflow only synchronizes non-secret MicroVM release configuration into
Trigger.dev. The dedicated AWS runtime identity credentials and the existing
Convex/Centrifugo secrets must already be configured directly in Vercel and
Trigger.dev as described above; they are not copied through GitHub Actions.

## 5. Validate before broader rollout

Use an internal paid account and select **Cloud** in Agent mode. Confirm the
first terminal command creates one MicroVM and later commands reuse it. Then run
the following only against systems you own or are authorized to test:

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

For network correctness, start known open and closed TCP/UDP listeners on a
separate controlled host. Verify `nc`, `nmap -sT`, `nmap -sS`, `naabu`, and a UDP
probe report the expected mix rather than every port as open. Also test ICMP,
`tcpdump`, an outbound callback/listener flow, command cancellation, PTY
interaction, file creation/download, and a second command after several
minutes.

Finally, use **Settings -> Data Controls -> Delete terminal sandbox** and verify
the MicroVM becomes `TERMINATED` in AWS. Check the
`cloud_sandbox_provider_selected` PostHog event and structured
`cloud_sandbox_*` logs for the test user.

## Rollback

Terminate existing AWS MicroVM sessions from Data Controls or AWS first. Then
set `CLOUD_SANDBOX_PROVIDER=e2b` in both Vercel and Trigger.dev and redeploy.
The provider never silently falls
back from AWS to E2B, so configuration or quota failures stay visible during
the internal rollout.

## Known boundaries

- Lambda's public inbound endpoint supports application protocols over HTTPS,
  not arbitrary inbound TCP/UDP. HackerAI therefore uses outbound Centrifugo
  for command transport. Reverse-listener scenarios still require an external
  relay or a VPC design that supports the required callback path.
- The managed internet connector must be validated with the capability suite;
  guest raw-socket capability alone does not prove that every network path has
  native semantics.
- The full HackerAI tool image requires the 4 GiB / 2 vCPU baseline so its
  build and runtime filesystem have 16 GB of disk. Current first-tier US
  pricing is roughly $0.252/hour while running, before burst compute,
  snapshots, and data transfer.
- AWS penetration-testing rules and the target owner's authorization still
  apply to traffic originating from the account.
