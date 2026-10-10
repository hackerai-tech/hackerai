# Private lab VPN feasibility fixture

An internal prototype for [HAC-155](https://linear.app/hackerai/issue/HAC-155).
It establishes a real OpenVPN connection to a disposable private lab, then
uses an authenticated SOCKS gateway to reach HTTP and SSH services from a
separate tool runner. It does not connect to E2B, change application routing,
or import customer VPN profiles. It generates a self-contained `.ovpn` file
with inline credentials and tests identical bytes in both paths.

## Run

Requires a local Linux Docker engine with `/dev/net/tun` (including a local
Linux VM on macOS). Use an explicit context. No host ports are published and
no host routes or default Docker context are changed.

```sh
docker --context colima build -t hackerai-vpn-prototype:local scripts/vpn-lab-prototype
python3 scripts/vpn-lab-prototype/run.py \
  --context colima \
  --image hackerai-vpn-prototype:local
# Repeat with a TCP OpenVPN profile and a separate result file:
python3 scripts/vpn-lab-prototype/run.py \
  --context colima \
  --image hackerai-vpn-prototype:local \
  --protocol tcp \
  --output .artifacts/vpn-lab-prototype/result-tcp.json
```

The build downloads Debian packages. Runtime networks are Docker `--internal`
networks, and test credentials are generated without network access. Only the
gateway and VPN server receive `NET_ADMIN` and access to `/dev/net/tun`.
Use this fixture on a trusted local machine, not a shared production Docker
host. There is no Docker socket or host filesystem mount inside the fixture
other than its own temporary credentials directory.

The JSON result defaults to `.artifacts/vpn-lab-prototype/result.json` and
records the exact image ID, checks and cleanup result. Containers and networks
use a unique `hackerai-vpn-spike-*` prefix and label. They are removed on success
or failure. Temporary VPN/SSH credentials are deleted after teardown. The
Docker image and build cache remain for another run. A force-killed host
process can prevent cleanup; inspect only resources with the recorded prefix.

## What a passing run proves

- The same generated `.ovpn` profile (matching SHA-256 fingerprints) fails
  specifically on TUN/TAP creation in the baseline runner, then connects on
  the gateway. Both paths can reach the same ready VPN server.
- The baseline cannot fetch the HTTP response or perform the SSH login.
- A runner with no direct private-lab route can fetch the exact expected HTTP
  response through the authenticated VPN gateway.
- SSH performs a real public-key login with a verified server host key.
- Wrong proxy credentials, unapproved hosts/ports and metadata addresses fail.
- A known closed TCP service is rejected in this local topology.
- VPN termination blocks private access, even when an alternate route exists.
- Reconnecting restores both HTTP and SSH access.

The proxy's credentials and destination rules are tested, but this is not a
complete multi-tenant isolation review. Customer traffic encryption between
Cloud and the gateway, session lifecycle, internal DNS, IPv6, MTU behavior,
provider policy, concurrent sessions and cloud deployment are not validated.
SOCKS username/password is not encrypted by itself: production must use an
encrypted transport. The unencrypted proxy in this fixture is confined to its
private Docker network.

The baseline is a local model of the missing-TUN limitation documented in
`lib/system-prompt.ts`, not the old HackerAI application or an E2B sandbox.
These tests demonstrate the architectural difference; they cannot establish
that the old cloud version fails and the new cloud version works. The result
explicitly records `actual_e2b_tested: false`. The PR adds a reproducible
prototype, not a customer-facing VPN fix or support for arbitrary VPN files.
`--protocol` selects the OpenVPN tunnel transport; a TCP profile passing does
not validate raw scanning or UDP application traffic through SOCKS.

## Product boundary

HAC-88 already rejected E2B BYO Proxy as a port-scan accuracy fix. This fixture
must not be used to claim that E2B's false-open behavior is solved. Real
application responses are the acceptance signal for a future E2B-plus-gateway
integration. Native scanning, UDP, raw packets and callbacks require separate
capability tests and may require tools to execute on a VPN-capable VM.

Before a customer-facing release:

1. Repeat the acceptance suite against a disposable, independently identified
   cloud environment and an owned private target, with target-side evidence.
2. Choose per-session VM isolation and authenticate and encrypt the entire
   Cloud-to-gateway path. Keep destination allowlists and stop on route loss.
3. Treat uploaded `.ovpn` files as untrusted input. Parse a supported subset
   into a generated config; never execute arbitrary `up`, `down`, `plugin`,
   management, shell, include or path directives from the uploaded file.
   Secrets belong in protected session storage, never chat/model context,
   telemetry, image layers or command arguments.
4. Implement expiry, disconnect/revoke, resource cleanup and cost limits, then
   verify concurrent tenant isolation and recovery before a staged rollout.
5. Test the user journey: protected upload, connection state, target check,
   useful Agent task, reconnect and downloadable result. A connected tunnel
   alone is not successful activation.

The test source is under `scripts/` so a prototype change cannot trigger the
production sandbox image workflow, which watches `docker/**` on `main`.
