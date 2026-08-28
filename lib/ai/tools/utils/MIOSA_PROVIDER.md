# MIOSA as a cloud sandbox provider

Opt-in. `CLOUD_SANDBOX_PROVIDER` still defaults to `e2b`, and nothing in the
E2B path changes.

## Why this fits without restructuring the agent

MIOSA is a Firecracker microVM platform, and the sandbox **is** the image - the
same model as E2B's `Template().fromDockerfile()`, not a container running
inside a VM. `docker/Dockerfile` is the rootfs on both providers, so the agent's
tool paths, `/home/user` workdir, and installed binaries are identical.

That is why this integration is three small files rather than a port.

## What is here

| file                                       | role                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `miosa-sandbox.ts`                         | `MiosaSandbox`, implementing `CommonSandboxInterface` with `sandboxKind = "miosa"` |
| `cloud-sandbox-provider.ts`                | `CloudSandboxProvider` widened to `"e2b" \| "miosa"`                               |
| `__tests__/cloud-sandbox-provider.test.ts` | selection + fail-closed coverage for both                                          |

`MiosaSandbox` satisfies the same contract `CentrifugoSandbox` does, so
`asCommonSandbox()` and every call site that already goes through it work
unchanged.

## Configuration

```bash
CLOUD_SANDBOX_PROVIDER=miosa
MIOSA_API_KEY=msk_...
MIOSA_TEMPLATE_ID=hackerai-kali   # the rootfs built from docker/Dockerfile
MIOSA_ENDPOINT=https://api.miosa.ai   # optional
```

```ts
import { MiosaSandbox, isMiosaSandbox } from "./miosa-sandbox";

const sandbox = await MiosaSandbox.create({
  templateId: process.env.MIOSA_TEMPLATE_ID,
  size: "medium",
  timeoutSec: 3600,
});

const { stdout, exitCode } = await sandbox.commands.run("nmap --version", {
  cwd: "/home/user",
});
```

Reattach with `MiosaSandbox.connect(sandboxId)`.

## Two places the contract does not line up, and how each is handled

**1. `getHost(port)` is synchronous; MIOSA resolves a preview URL over the
network.** The host is resolved once during `create()` and cached, so the
accessor stays synchronous and the interface is unchanged. For any other port,
call `await sandbox.prewarmHost(port)` first.

`getHost` on an unwarmed port **throws** rather than returning a constructed
URL. A fabricated host would fail later, somewhere else, and read as a network
fault rather than a missing call.

**2. MIOSA has no file-delete endpoint yet**, so `files.remove` shells out to
`rm -f`. It is marked in the source for replacement when a native call exists,
and it raises on a non-zero exit rather than resolving as though the file were
gone.

## Deliberately not done in this PR

`lib/ai/tools/utils/sandbox.ts` is **untouched**. Its lifecycle - E2B clusters,
leases, 429 retry, auto-pause/auto-resume - is E2B-shaped and load-bearing, and
rewriting it to be provider-generic is a change that deserves its own review
rather than riding along with an adapter.

The seam to do that later is `getSandbox()`: branch on
`getCloudSandboxProvider()` before the cluster lookup, since MIOSA has no
cluster concept. Happy to follow up with that once the adapter itself is
agreed.

## Mapping, for review

| `CommonSandboxInterface` | MIOSA SDK                                                                     |
| ------------------------ | ----------------------------------------------------------------------------- |
| `commands.run`           | `sandbox.exec.run` / `sandbox.exec.stream` when `onStdout`/`signal` is passed |
| `files.write`            | `sandbox.files.write`                                                         |
| `files.read`             | `sandbox.files.readText`                                                      |
| `files.list`             | `sandbox.files.list`                                                          |
| `files.remove`           | `exec rm -f` (no native endpoint yet)                                         |
| `getHost`                | `sandbox.expose(port)`, resolved at create and cached                         |
| `close`                  | `sandbox.destroy()`                                                           |

`timeoutMs` is converted to MIOSA's seconds and rounded **up** - rounding down
would cut a command short of the budget the caller asked for.
