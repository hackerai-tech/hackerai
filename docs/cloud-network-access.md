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
transforms are rejected rather than cleared by this editor.

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
