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
writes is the managed egress pilot's below.

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

## Managed egress pilot

A server-managed SOCKS5 egress pilot is disabled by default and limited to
fresh, disposable internal QA accounts. Set the same values in the web server
and the Agent worker for the environment being tested, so network settings and
sandbox acquisition agree. The values are fixed for each process lifetime.

- `E2B_MANAGED_EGRESS_USERS`: comma-separated exact WorkOS user IDs. Empty or
  unset disables the pilot. Other accounts keep the mapping above unchanged and
  never read the other variables.
- `E2B_MANAGED_EGRESS_US_PROXY` and `E2B_MANAGED_EGRESS_EU_PROXY`: server-only
  JSON for each region's proxy, with exactly `address` (`host:port`), a
  dedicated nonempty `username` and `password`, each at most 255 UTF-8 bytes.
  The two proxies must be on different hosts.
- `E2B_MANAGED_EGRESS_DESTINATIONS`: comma-separated exact, lowercase DNS
  names shared by both regions. Wildcards, IP addresses, single labels, URLs,
  paths and ports are rejected.

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
the writer lease or any provider call; it never falls back to direct egress. The effective
E2B policy is deny-all plus the approved destinations that the saved setting
also permits: Internet access permits all of them, allowed-destinations mode
permits exact or wildcard-subdomain matches, and saved IP/CIDR grants permit
none. No internet stays deny-all. Every create and update includes the proxy,
including offline, because an E2B network update replaces the whole
configuration. Settings and the Agent network summary still describe the saved
setting, not this narrower effective policy.

Use a dedicated proxy with a static public IP in each region, require
authentication, and restrict inbound connections to the source ranges E2B
confirms for that region's cluster.
E2B hostname rules cover HTTP on port 80 and TLS on port 443, and E2B allows
its resolver address when using hostnames. Enforce the exact owned destination
list and port 443 on the proxy too. Deny internal addresses, including after
DNS resolution. E2B tunnels TCP only. Allowed UDP, including DNS, uses the
direct path.

E2B readback omits the password, so acquisition compares the returned proxy
address and username plus the allow and deny lists, on every acquisition rather
than from the in-memory revision cache. A missing proxy is written through the
normal writer and read back; a mismatch after writing fails acquisition. A
different proxy, including the other region's, a credential transform, or a
pilot proxy on a non-enrolled account is rejected, never overwritten or
cleared. Because a matching address
and username are not rewritten, a password change on the same username is not
applied to existing workspaces: change the endpoint or credentials only with a
new disposable workspace or an approved explicit migration. To roll back,
delete the account's disposable workspaces through the normal controls first,
then remove its enrollment; a workspace still carrying the proxy after
unenrollment is rejected rather than silently opened to direct egress.

Before expanding enrollment, check in each region that an owned HTTPS endpoint
observes that region's proxy IP, verify that a destination outside the
allowlist is denied, and test
uploads and downloads in the Agent. Repeat the allowed request after a pause
and resume, then with the pilot proxy unavailable. The latter should fail
without reaching the endpoint over E2B's shared IP. Record transfer volume and
peak concurrent connections before deciding how many proxies are needed.
