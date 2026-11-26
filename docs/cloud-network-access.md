# Cloud network access

Settings > Agents exposes an explicit workspace-wide outbound network policy:
existing internet access, allowed destinations only, or no internet. The policy
is stored per user, because cloud workspaces are currently reused across chats.
Chat instructions never silently change this shared setting. Local/Desktop connections
and server-side reader requests are outside this E2B control.

E2B Agent and delegated runs reload a network-settings system-prompt section
each model step, independently of conversation compaction. It includes the
saved mode and at most ten complete allowlist entries, capped at 400 tokens
for the entire section using the application's tokenizer (provider tokenization
may differ). Omitted entries are counted; the full saved list still governs
E2B. Local/Desktop and Ask-only runs do not receive this section. Failed or
pending updates are described as unverified desired settings; a failed read
never becomes an unrestricted-access claim. This summary adds no network grants.

The E2B adapter updates running workspaces in place and reads the resulting
configuration back before reporting success. It never deletes a workspace or
writes its files. Paused workspaces receive the saved policy on acquisition;
new workspaces are created with it. Provider writes are serialized with a
revision and bounded operation fence. Failures retain the desired policy and
report uncertain/partial application; an interrupted update can be retried after
the fence expires. Failures before any provider write release the fence immediately
so canceled reads do not delay the next attempt. A provider operation already dispatched is not an atomic
revocation of existing traffic. Externally managed egress proxies or credential
transforms are rejected rather than cleared by this editor; the only proxy it
writes is the managed egress proxy below.

Only hostnames/wildcards and IPv4 addresses/CIDRs are supported. E2B hostname
filtering covers HTTP 80 and TLS 443 and allows its DNS resolver. IP grants cover
other ports too. URL paths, per-domain exclusions, activity limits, QUIC hostname
filtering and strict shared-CDN isolation cannot be represented by this setting.
Do not expand a hostname to its resolved/shared IP or flatten task instructions
with exclusions into a broader allowlist.

For Preview acceptance, record the sandbox ID and a disposable file checksum,
save a restricted policy in Settings, and verify application-level responses
for an allowed and a blocked destination. A successful TCP connect alone does
not prove traffic passed E2B's filter. Verify the same ID/checksum after updating
and reconnecting, test offline execution, then restore the test account's
original network policy. The default behavior stays unchanged until a user
explicitly saves this setting.

## Managed egress

Server-managed SOCKS5 egress routes cloud workspace TCP traffic through an
owned proxy with a static public IP in the workspace's region. It is disabled
by default. It can be enabled for every account, or for exact pilot accounts.
Set the same values in the web server and the Agent worker for the
environment, so network settings and sandbox acquisition agree. The values are
fixed for each process lifetime. Cloud plan authorization is unchanged: the
setting only affects accounts that can already use cloud workspaces.

- `E2B_MANAGED_EGRESS_ENABLED`: exactly `true` enrolls every account and
  ignores the pilot list. Unset, empty or `false` keeps the pilot list below.
  Any other value, including `TRUE`, `1` or surrounding whitespace, fails every
  account closed rather than guessing.
- `E2B_MANAGED_EGRESS_USERS`: comma-separated exact WorkOS user IDs for the
  pilot. Empty or unset enrolls nobody. Accounts that are not enrolled keep the
  mapping above unchanged and never read the other variables.
- `E2B_MANAGED_EGRESS_US_PROXY` and `E2B_MANAGED_EGRESS_EU_PROXY`: server-only
  JSON for each region's proxy, with exactly `address` (`host:port`), a
  dedicated nonempty `username` and `password`, each at most 255 UTF-8 bytes.
  The two proxies must be on different hosts.
- `E2B_MANAGED_EGRESS_DESTINATIONS`: either `*` alone, for general egress, or
  comma-separated exact, lowercase DNS names shared by both regions, for a
  hostname allowlist. `*` combined with any other entry, wildcards, IP
  addresses, single labels, URLs, paths and ports are rejected.

The standing configuration for general egress is `E2B_MANAGED_EGRESS_ENABLED=true`,
`E2B_MANAGED_EGRESS_DESTINATIONS=*` and both regional proxies.

A workspace uses the proxy of the E2B cluster that hosts it. That cluster comes
from the existing Trigger region routing: `us-east-1` and `us-west-2` select
E2B US and the US proxy, and `eu-central-1` selects E2B EU and the EU proxy.
Acquisition passes the cluster it routed through; Settings and acquisition
reconciliation select the proxy for each cluster whose inventory they are
listing. The region is never derived from the user's IP or plan, provider
metadata, or where a proxy is hosted, and there is no cross-region fallback.

For an enrolled account, both regional proxies and the destinations must be
valid whichever region it uses. Missing or malformed configuration fails
sandbox creation, acquisition and Settings saves with a generic error before
the writer lease or any provider call; it never falls back to direct egress.
Every create and update includes the proxy, including offline, because an E2B
network update replaces the whole configuration.

With general egress (`*`), the E2B policy is exactly the mapping above plus
the proxy. Internet access keeps E2B's default TCP reachability, allowed
destinations keep their hostnames, wildcards, IPs and CIDRs, and No internet
stays deny-all. E2B applies the saved rules first and tunnels permitted TCP
through the proxy; UDP, including DNS and QUIC, is not tunneled and follows
E2B's own direct path and shared IP.

With a hostname list, the effective E2B policy is deny-all plus the listed
destinations that the saved setting also permits: Internet access permits all
of them, allowed-destinations mode permits exact or wildcard-subdomain matches,
and saved IP/CIDR grants permit none. Settings and the Agent network summary
still describe the saved setting, not this narrower effective policy.

Use a dedicated proxy with a static public IP in each region, require
authentication, and restrict inbound connections to the source ranges E2B
confirms for that region's cluster. Deny private, loopback, link-local
(including cloud metadata) and the proxy's own network addresses, including
after DNS resolution. For general egress, permit other public TCP destinations
and ports, and size the proxy for all enrolled traffic. For a hostname list,
also enforce the exact destination list and port 443 on the proxy; E2B hostname
rules cover HTTP on port 80 and TLS on port 443, and E2B allows its resolver
address when using hostnames.

E2B readback omits the password, so acquisition compares the returned proxy
address and username plus the allow and deny lists, on every acquisition rather
than from the in-memory revision cache. This adds one provider read per
acquisition for every enrolled account. A missing proxy is written through the
normal writer and read back; a mismatch after writing fails acquisition. A
different proxy, including the other region's, a credential transform, or a
managed proxy on an account that is not enrolled is rejected, never overwritten
or cleared.

### Migration

Enable general egress in Preview before Production, with the same values in
the web server and the Agent worker, and restart both. Until both run the same
values, a process that disagrees about enrollment rejects the other's
workspaces with a retryable error; it never opens direct egress or deletes a
workspace.

Existing workspaces are not recreated, rebooted or deleted, and their files
are preserved. A running or resumed workspace gains its region's proxy through
an in-place network update the next time it is acquired or its owner saves
Settings. Workspaces that are not used keep direct egress until then. An
account that never saved a setting gets the default Internet access setting
saved by that first update; its behavior is unchanged.

### Rollback

A workspace keeps the proxy address and username it was given, apart from the
one move from the shared credential to its own described in
[Per-workspace attribution](#per-workspace-attribution). Acquisition rejects
any workspace carrying a different managed proxy, and the editor never clears
it. Disabling enrollment, or changing a region's proxy address or
username, therefore makes every workspace that still carries the previous proxy
unavailable. Nothing is deleted or opened to direct egress, and restoring the
previous values restores those workspaces.

To preserve customer workspaces:

- Keep each region's address and username stable for as long as workspaces
  carry them. Repair or replace the proxy host behind the same address. A
  password change on the same username is not applied to existing workspaces,
  so keep the existing password valid on the proxy.
- If a proxy fails, its region's workspaces lose tunneled TCP but remain
  available with their files; restore the proxy rather than disabling
  enrollment.
- To undo a configuration change that made workspaces unavailable, restore the
  previous values in both processes.
- Returning existing workspaces to direct egress, or moving them to a new proxy
  identity, is not supported by configuration alone and needs a deliberate,
  reviewed migration.

For pilot accounts, which use disposable workspaces, delete the account's
workspaces through the normal controls first, then remove its enrollment.

### Acceptance

Before enabling for every account, check in each region that an owned HTTPS
endpoint observes that region's proxy IP for Internet access, an allowed IP or
CIDR destination, and an allowed hostname; that a destination outside a
restricted policy is denied; and that No internet stays offline. Test uploads
and downloads in the Agent. Repeat a request after pause and resume, and after
an existing direct workspace migrates in place with its files intact. With the
proxy unavailable, the request should fail without reaching the endpoint over
E2B's shared IP. Record transfer volume and peak concurrent connections before
deciding proxy capacity.

### Egress health monitor

The `egress-health-us` and `egress-health-eu` Trigger tasks check each region's
proxy every five minutes, scheduled in Production only. Each run creates one
short-lived disposable sandbox on that region's E2B cluster and current
template, with no account metadata, a network policy that allows only
`convex.haiusercontent.com` behind deny-all, and the region's managed proxy. It
makes one HTTPS request, without redirects or retries, to that host's
`/cdn-cgi/trace`, compares the reported `ip` with the expected static IP, and
then deletes the sandbox. The sandbox's own timeout removes it if deletion
fails or the run is interrupted. Customer sandboxes and settings are not used
or changed.

The monitor is off until the Agent worker sets
`E2B_EGRESS_MONITOR_ENABLED=true`, and needs:

- general managed egress (`E2B_MANAGED_EGRESS_ENABLED=true`) with both
  regional proxies; a hostname list must include the probe host;
- the region's E2B credentials used for customer sandboxes;
- `E2B_EGRESS_MONITOR_US_IP` and `E2B_EGRESS_MONITOR_EU_IP`: each region's
  expected static public IPv4 address, set independently of the proxy
  configuration;
- the worker's existing Redis connection.

Missing or invalid values fail the run with a generic configuration error
before any sandbox is created. To test it on a Preview worker, enable it there
with that environment's values and run the task manually from the dashboard.

A run fails and is visible to the environment's Trigger error alerts when:

- the observed IP differs from the expected IP (immediately);
- the probe gets no valid answer in two consecutive five-minute windows,
  counted per region, with duplicate runs in one window counted once;
- the probe sandbox cannot be deleted;
- configuration is missing or the unavailable streak cannot be recorded.

A single unavailable probe completes with an `unavailable` result and a
warning log, and a healthy probe resets the streak. The run list records
each failure while the condition lasts. Logs
and errors name only the region, outcome and failed stage, never responses,
IP addresses, credentials or provider errors.

When the monitor reports a region unavailable or a wrong IP, repair or replace
that region's proxy host in the same region and reattach the existing static
IP, keeping the same proxy address, username and password (see Rollback).
A different proxy address or username strands existing workspaces, and a
different public IP breaks destinations that allowlist the current one, so do
not change the expected IP to silence the alert.

## Per-workspace attribution

Attribution gives each managed-egress workspace its own SOCKS5 credential on
the same regional proxy address and static IP, so operators can see which
owner's workspaces open bursts of proxy connections. It is off by default,
only alerts, and never blocks, suspends or rate-limits anyone. The proxy-side
module and collector, and their installation, are in
[scripts/egress](../scripts/egress/README.md).

The username is `hae-v1-<owner>-<workspace>`, two opaque 128-bit HMAC
references derived with the region's key; the password is an HMAC of that
username and the region. Nothing in either reveals the user or sandbox ID. The
proxy recomputes the password with its own region's key, so a credential from
another region, another workspace or a guessed reference is rejected. The
`hae-` prefix is reserved on the proxy: a malformed name in it fails rather
than reaching the shared login, so the shared username must not use it.

Credentials are assigned only during acquisition reconciliation or a Settings
save, after E2B confirms the workspace's owner:

- A workspace with no proxy, or with exactly its region's shared address and
  username, moves to its attributed credential once enrolled. Its files and
  network policy are unchanged; only the credential is rewritten.
- A workspace that already carries its own attributed credential keeps it
  whenever the keys are configured, even after its owner leaves the pilot.
- Any other proxy, including another workspace's or region's attributed
  credential, is rejected as before, never replaced or cleared.

Before switching a workspace, acquisition records the reference in a Redis
registry that maps it to the verified user and sandbox for seven days,
refreshed on each acquisition. A reference already mapped to someone else
fails acquisition closed. While the registry is unavailable a workspace keeps
its current credential and is switched on a later acquisition. Registration
waits at most two seconds, so an unresponsive registry cannot stall acquisition.

### Configuration

Set the same values in the web server and the Agent worker, after the proxies
accept attributed credentials:

- `E2B_EGRESS_ATTRIBUTION_ENABLED`: exactly `true` enrolls every
  managed-egress account; unset, empty or `false` keeps the pilot list; any
  other value fails closed for every managed-egress account.
- `E2B_EGRESS_ATTRIBUTION_USERS`: comma-separated exact WorkOS user IDs for
  the pilot.
- `E2B_EGRESS_ATTRIBUTION_US_KEY` and `E2B_EGRESS_ATTRIBUTION_EU_KEY`: each
  region's 64-character lowercase hex signing key, installed on that region's
  proxy as well. Without enrollment, keys alone keep existing attributed
  workspaces recognized. Set both valid keys before enabling anything: once
  either key variable is set, a single key, a malformed key, one key for both
  regions, a key equal to a telemetry key in the same process, enrollment
  without keys or a shared username in the reserved namespace fails every
  managed-egress account closed with the generic error, like other invalid
  configuration.

The collector on each proxy uploads to `/api/internal/egress-telemetry` on
the web server, which needs:

- `E2B_EGRESS_TELEMETRY_US_KEY` and `E2B_EGRESS_TELEMETRY_EU_KEY`: 64-character
  lowercase hex keys, one per region. Generate every attribution and
  telemetry key independently. Uploads for a region are rejected while its key
  is missing, malformed, or equal to the other region's key or an attribution
  key in the same process.
- The existing Redis connection, which must be the same Redis that the Agent
  worker uses.

The route is outside AuthKit and authenticates each request itself: a region
header, a timestamp within five minutes and an HMAC over both and the body,
checked before the body is parsed or stored. Bodies are limited to 128 KiB,
including chunked uploads, and must match a fixed schema of opaque references
and counts. Each region and minute is stored once; a retry of the same body is
acknowledged as a duplicate and a different body is rejected. Responses
contain only a status, and there is no read API.

Keys are per environment and per region. A proxy host holds one environment's
keys, so Preview attribution needs Preview proxies; never copy Production keys
to Preview or the reverse.

### Burst alerts

The `egress-burst-alerts` Trigger task runs every minute, scheduled in
Production only. It is off until the Agent worker sets
`E2B_EGRESS_BURST_ALERTS_ENABLED=true`, `E2B_EGRESS_BURST_THRESHOLD`, the
number of accepted attributed connections from one owner's workspaces in one
region and minute that counts as high volume. There is no default threshold.
Choose it from observed telemetry before enabling. An invalid toggle or a
missing, zero or fractional threshold fails the run.

Each run reads the five most recent settled minutes for both regions, so a
briefly late upload is still evaluated. The run logs a `High connection volume`
warning in Trigger when an owner's total across its workspaces, or the
connections beyond the collector's identity bound, reaches the threshold. The
warning includes the region, minute, observed count and threshold. For
attributed traffic, it also includes the opaque owner reference, registered
user ID and verified sandbox IDs. Review warnings in the Trigger run logs.

A run fails and reaches the environment's existing Trigger error alerts when:

- its configuration is missing or invalid
- a region has uploaded nothing in the five most recent settled minutes
- a collector reported an incomplete minute, dropped events or dropped batches
- telemetry or the registry cannot be read, or a warning cannot be written or
  recorded
- an abuse review cannot be queued or dispatched, or expires before dispatch

Warnings are deduplicated per region, minute and owner. Each run logs up to
20 new warnings, largest first. Later runs can log the rest while their minute
is still in the evaluation window. A failed log or write of the deduplication
mark can be retried in the next run. An uncertain write can repeat the warning.

Incomplete minutes include the first partial minute after initial installation.
Wait for it to leave the evaluation window before expecting a clean run.

#### Missing heartbeat

A `<region> collector heartbeat missing` failure says only that no upload for
that region was stored for any minute in the window. Compare the window from
three places before naming a cause:

1. The failed run logs `Egress collector heartbeat missing` with the region and
   the exact settled UTC window, `windowStart` (inclusive) to `windowEnd`
   (exclusive).
2. In the web server's Production logs, find `egress_telemetry_received` for
   the region. Each receipt gives the batch `minute`, its `outcome` and
   `delayAfterMinuteEndS`. A receipt for a window minute with a large delay
   means the batch arrived late. With no receipt, look for
   `egress_telemetry_rejected`, `egress_telemetry_store_failed` and
   `egress_telemetry_misconfigured`. Unparseable or oversized bodies are
   answered without a log line.
3. On the region's proxy host, read the collector's journal for a few minutes
   around the window, in UTC:

   ```sh
   journalctl --utc -o short-iso -u hackerai-egress-collector.service \
     --since '<windowStart minus 5 min, with UTC suffix>' \
     --until '<windowEnd plus 5 min, with UTC suffix>'
   ```

   - `started` marks a new process with its saved backlog: `pending`,
     `oldest_minute` and `oldest_age_s`. After a restart, `last_success` is
     `unavailable`, since it is not persisted.
   - `upload deferred` gives the HTTP status, or `status=unknown` with a
     coarse `transport` (`timeout`, `tls`, `dns`, `refused`, `connection`,
     `network`, `invalid`), the attempt number, the oldest pending minute and age, and
     the last success.
   - `upload recovered` appears once per outage, with the number of deferred
     attempts, the outage length and the age of the batch delivered first.
   - `journal stream ended` means the journal reader was restarted.

   `systemctl status hackerai-egress-collector.service` shows restarts and
   exit codes.

Compare HTTP failures with route rejections, store failures, and edge logs.
A transport outcome without matching receipts points to the path between
the host and the web server. If both logs are empty, check retention and the
collector's service state before inferring a stop. The SOCKS health monitor
probes the traffic path independently of telemetry collection.
These logs carry no keys, payloads, identities, addresses or destinations.

To verify the monitor in Preview, upload synthetic telemetry above the Preview
threshold, then trigger `egress-burst-alerts` manually in Preview with a
`timestamp` two minutes after the synthetic minute. Confirm that the run
succeeds and logs the expected warning.

Counts are accepted authenticated SOCKS connections, not HTTP requests: one
connection can carry many requests, and exact request counts are not
available.

With `E2B_EGRESS_ABUSE_REVIEW_ENABLED=true` in the web server, Agent worker
and Convex, each burst from a complete minute is also handed to the read-only
`egress-abuse-review` task, once per owner reference, region and 30-minute UTC
window, after a short delay so the active run can persist its messages.
Overflow and incomplete minutes are never reviewed. The payload carries only
the region, owner reference and minute. Unset or `false` disables review. An
invalid value warns and disables review while original alerts continue. See
[Automated egress burst review](abuse-response.md#automated-egress-burst-review).

The Redis queue keeps deferred reviews beyond the five-minute alert window.
The worker replays retained telemetry up to 30 minutes old to recover failed
queue writes. The queue holds up to 2,000 entries. Each run attempts up to
10 dispatches, prioritizing untried entries within its batch. Retries use the
same idempotency key. Entries over 30 minutes old are removed and reported as
expired when no dispatch mark exists. Queue and dispatch failures surface as
errors. Disabling review pauses the queue. Entries still eligible can resume
when review is enabled again. An idle queue expires two hours after its last
addition. Before queuing a new case, the monitor skips a routine spike from an
account under a review cooldown; see
[Account cooldown](abuse-response.md#automated-egress-burst-review).

While the toggle is on, every successful cloud acquisition with a server chat
and Trigger run also records a short-lived link from the verified workspace to
that chat, run and time, after ownership and network verification. The write is
best effort and not awaited, so a store outage cannot delay or fail an
acquisition. The review selects each run's latest acquisition before the
burst ended and checks the run's persisted timing for overlap. It uses up to
16 records per workspace from the six hours before the burst. Additional
records signal incomplete coverage and route the case to manual review. A
run's repeated reconnects are coalesced atomically without losing the record
that places it before a burst; see
[Acquisition links](abuse-response.md#automated-egress-burst-review). The
older per-run format expires on its original six-hour schedule. These links
are separate from attribution credentials.
`E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED=true` adds a diagnostic-only run
timeline at the same boundary; see
[Run timeline shadow](abuse-response.md#run-timeline-shadow).

### Coverage and delivery

Counts are lower bounds and only cover attributed credentials:

- A new workspace is created with the shared credential, because its sandbox
  ID is not known yet, and is switched by the acquisition that follows. Its
  traffic until then is unattributed, as is any workspace not acquired since
  enrollment.
- The egress health monitor and every workspace still on the shared
  credential are not counted and are never assigned a guessed owner. The
  monitor therefore proves only the shared login: it does not detect a proxy
  that rejects attributed credentials, so smoke-test an attributed credential
  in each region before enabling attribution there and after any proxy
  change.
- Late or future-stamped events are reported as lost rather than counted in
  another minute.
- Events lost to journald rate limiting, journal vacuuming or a collector
  outage beyond its 24-hour outbox are not recovered. Batches older than a day
  are acknowledged and discarded, and the alert task only evaluates the last
  five minutes. Detectable gaps are reported as incomplete minutes and dropped
  counts, never as zero.

### Rollout and rollback

Install and verify the proxy side first, in each region, while the
application issues only the shared credential: the shared login must keep
working through PAM, only that shared username may use it, and an attributed
credential for the region must connect while a forged one is denied. Then
start the collector and confirm a heartbeat each minute. In the web server
and Agent worker, set both keys with a pilot list, acquire a pilot workspace,
and confirm it connects with its attributed credential and is counted. Observe counts before choosing a threshold and
enabling alerts, and before global enrollment. Repeat in Preview, on Preview
proxies, before Production.

Rollback follows the managed-egress rule that a workspace keeps the identity
it was given:

- To stop new attribution, clear the pilot list or set
  `E2B_EGRESS_ATTRIBUTION_ENABLED=false`. Attributed workspaces stay pinned and
  keep working while the keys remain configured in both processes and on the
  proxies.
- Removing or changing a region's key, in the application or on its proxy, or
  returning Dante to its `username` method, makes every attributed workspace in
  that region unavailable or unable to connect. Nothing is deleted or opened to
  direct egress; restoring the previous key and configuration restores them.
  Moving attributed workspaces back to the shared credential needs a
  deliberate, reviewed migration.
- To stop alerts, set `E2B_EGRESS_BURST_ALERTS_ENABLED=false`. Stopping the
  collector does not affect traffic.
- To stop burst reviews and acquisition links, set
  `E2B_EGRESS_ABUSE_REVIEW_ENABLED=false` in the web server, Agent worker and
  Convex. This is separate from alerts, which continue unchanged under their
  own toggle. Existing links and queued reviews expire on their own, and
  existing cases stay available to operators.
