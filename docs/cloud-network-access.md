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

A workspace keeps the proxy address and username it was given. Acquisition
rejects any workspace carrying a different managed proxy, and the editor
never clears it. Disabling enrollment, or changing a region's proxy address or
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
