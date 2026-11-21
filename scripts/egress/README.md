# Egress attribution on the regional proxies

Source for the proxy-side half of per-workspace SOCKS attribution. The
application side, configuration and rollout are described in
[Cloud network access](../../docs/cloud-network-access.md#per-workspace-attribution).

- `pam_hackerai_egress.c`: PAM module for Dante's native `pam.username`
  method. It validates attributed credentials with the region's HMAC key and
  logs one fixed AUTHPRIV event per accepted attributed connection. There is no
  custom proxy, forwarder or per-account system user.
- `hackerai-egress.pam`: the `/etc/pam.d/hackerai-egress` service. The module
  decides every name: attributed `hae-` credentials itself, and only the
  region's configured shared username continues to `pam_unix` for the existing
  shared login. Every other host account is rejected.
- `collector.py` and `hackerai-egress-collector.service`: counts those events
  from danted's journal per workspace and minute, and uploads signed batches.
- `tests/`: unit tests and an isolated Dante + PAM integration run. Everything
  in `tests/credentials.json` is synthetic.

## Test

```sh
docker build --file scripts/egress/tests/Dockerfile --tag hackerai-egress-test scripts/egress
docker run --rm --network none hackerai-egress-test
```

The run uses distro Dante and Linux-PAM on Ubuntu 24.04, a loopback HTTP
target and no network. It covers attributed, forged, cross-region and
malformed credentials, local accounts inside and outside the reserved
namespace, the legacy login, an incompletely configured service, invalid key
files and recovery, and the collector's counts and signed upload. CI runs it
in the Linux safety integrations job.

Dante evaluates `pam.username` while matching the socks rule, after it has
already answered the RFC 1929 username/password exchange, so a PAM denial
reaches the client as SOCKS5 reply `0x02` (not allowed by ruleset). The test
accepts exactly that or a failed subnegotiation as a denial, reports any other
outcome by stage and code, and separately checks that no denied login reaches
the target.

## Install on a proxy host

Each region's host uses only its own region's keys, from the same environment
as the application that issues its credentials. Keep the existing
private-destination firewall and E2B source-range restrictions unchanged;
attribution does not replace them.

1. Build and install the module with `gcc`, `libpam0g-dev` and `libssl-dev`,
   using the flags in `tests/Dockerfile`, to
   `/usr/local/lib/hackerai-egress/pam_hackerai_egress.so` (root-owned, 0644).
2. Create `/etc/hackerai-egress` (root, 0700). Write the region's attribution
   key, the same 64 lowercase hex characters as the application's
   `E2B_EGRESS_ATTRIBUTION_US_KEY` or `_EU_KEY`, to `attribution.key` and the
   region's telemetry key to `telemetry.key`. Both files must be root-owned,
   mode 0600 and not symlinks; any other file fails closed. Write keys from a
   file or stdin, never command arguments.
3. Install `hackerai-egress.pam` as `/etc/pam.d/hackerai-egress`, replacing
   `REGION` with `us` or `eu` and `LEGACY` with the region's existing shared
   proxy username, the `username` in that region's
   `E2B_MANAGED_EGRESS_*_PROXY`. Until both are replaced, every login through
   the service fails, including the shared one. No per-workspace or other
   system account is created; the shared account stays as it is.
4. Switch Dante from its `username` method to PAM, keeping every other rule:

   ```text
   socksmethod: pam.username
   user.privileged: root
   socks pass {
     # existing from/to, command and protocol restrictions
     socksmethod: pam.username
     pam.servicename: hackerai-egress
   }
   ```

   Restart danted and confirm the existing shared login still works, for
   example with the egress health monitor. The monitor only uses the shared
   credential, so before issuing attributed credentials also smoke-test one
   attributed credential for this region from an E2B sandbox, and confirm a
   forged one is denied. Do not add connection or data logging for the
   collector; it reads only the module's events.

5. Raise journald's per-service rate limit for danted (a drop-in with
   `LogRateLimitIntervalSec=0`, or a burst above peak connections per 30
   seconds); suppressed messages are lost without notice.
6. Write `/etc/hackerai-egress/collector.json` (root, 0600):

   ```json
   {
     "version": 1,
     "region": "us",
     "endpoint": "https://<app host>/api/internal/egress-telemetry",
     "unit": "danted.service"
   }
   ```

   Install `collector.py` to `/usr/local/lib/hackerai-egress/`, then enable
   `hackerai-egress-collector.service`. Invalid configuration exits with
   status 78 without a restart loop.

The module reads its key on each authentication, so replacing the key file
applies without a restart. Changing a region's key, however, invalidates
every credential already issued with it (see Rollback in the linked document).

## Collector guarantees

The collector advances the journal cursor and counts in one SQLite
transaction and seals each minute into an immutable body, so restarts,
journal reconnects and upload retries do not double-count. It uploads one
batch per minute, including empty minutes, which serves as its heartbeat.

Counts are lower bounds. Entries dropped by journald rate limiting or vacuumed
before the collector reads them cannot be detected. The collector reports
what it can detect: a partial minute (first start, a lost cursor or a failed
journal stream) as `complete: false`; unreadable lines, and events stamped
for a minute already uploaded or ahead of the host clock, as `droppedEvents`
on the current minute, which is also marked incomplete (such events are never
moved into another minute); identities beyond 1,000 per minute as
`overflowConnections`; and batches it discarded (outbox beyond 24 hours, or
permanently rejected) as `droppedBatches` in a later batch. The alert task
fails on any reported dropped events or batches.
