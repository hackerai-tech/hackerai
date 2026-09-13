# Identifying Miosa workspaces

New sandboxes carry `userReference`, `environment`, and `identityVersion` metadata
plus tags such as `hackerai-user-c6c289e49e9c`. The reference is a shortened hash
of the stable WorkOS user ID. No email, account name, prompt, or scan target is
sent in these fields. Plan is intentionally omitted because it can change.

Miosa's dashboard must display metadata or tags for these labels to be visible.
Ask support for the sandbox UUID or complete existing name if labels are hidden.
The SDK does not update metadata on reuse, so existing sandboxes retain their
current metadata; the lookup works for their IDs and names immediately.

## Internal lookup

Use the read-only support command from an authorized operator workstation:

```sh
pnpm exec tsx scripts/miosa-lookup.ts --env-file /absolute/path/to/verified.env --email account@example.com
pnpm exec tsx scripts/miosa-lookup.ts --env-file /absolute/path/to/verified.env --reference hackerai-user-c6c289e49e9c
pnpm exec tsx scripts/miosa-lookup.ts --env-file /absolute/path/to/verified.env --sandbox-id SANDBOX_UUID
```

Before running, verify the file's WorkOS account/client and Miosa tenant both
belong to the intended HackerAI environment. The command loads only this file,
never another checkout's configuration or ambient credentials. Required fields
are `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and `MIOSA_API_KEY`; `MIOSA_BASE_URL`
is optional. Do not copy credentials between environments to run the lookup.

Output includes the matching account's name/email, full external user identity,
reference, sandbox IDs, state, and template. It contains personal information:
keep it internal and share only the pseudonymous reference/UUID with Miosa.
Email lookup is direct; reverse lookup paginates through WorkOS accounts and
can be slower. Zero matches can mean a deleted account or the wrong environment.
Multiple matches are rejected; use the full existing workspace name or UUID.
SDK sandbox listing determines which workspaces are returned, including whether
destroyed workspaces are available.

## Compatibility

The 24-character external user hash, external workspace ID, and `-v2` sandbox
name remain unchanged. Support references are labels, not authorization keys.
No sandbox is created, resumed, renamed, or destroyed by the lookup. Environment
metadata comes from `TRIGGER_ENV` or `VERCEL_ENV`; without a recognized explicit
value it is `unknown`, since `NODE_ENV=production` can also mean Preview.

Verify a new sandbox's tags/metadata and look it up by UUID. Then use a paused
existing sandbox's name to confirm its owner resolves while it remains paused.
