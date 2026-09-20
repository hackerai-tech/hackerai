# Local environment identity

Local computer selections refer to an installation, not its current relay
session. Updated CLI and Desktop clients persist an opaque UUID, while every
connection still receives a fresh session ID and authenticated relay channel.
An environment ID is a routing label, **not an authentication credential**;
all resolution remains scoped to the authenticated user.

Preferences use `environment:<uuid>` for CLI runners and
`desktop-environment:<uuid>` for Desktop. The transport distinction preserves
Desktop-specific file and project handling. A new task resolves the newest
ready, healthy session for the selected environment. An active task retains
its healthy session. A disconnected environment stays selected and fails
closed instead of falling back to another computer or Cloud. Reconnection
does not imply replaying an already-published command.

## Compatibility and rollout

Deploy the optional schema fields and backend functions first, then the web
and Trigger worker code, before publishing the updated CLI or promoting the
Desktop build. New clients register as not ready until their command relay
has subscribed. Old clients omit the new fields and retain existing behavior.
This is a reconnect correctness migration, not a randomized UX experiment;
client support gates adoption without changing plan or authorization rules.

Owned legacy session preferences can be upgraded exactly when their retained
connection record contains an environment ID. This lookup must never infer
identity from a hostname, display name, OS, or another user's connection.
Pre-migration sessions and already-purged records cannot be mapped reliably;
those selections require explicitly choosing the updated runner once.
The legacy `desktop` alias remains supported as the current Desktop default.
Tasks persist the resolved stable ID once a modern session is acquired.

The CLI stores its ID in `~/.hackerai/local/environment-id`; Desktop uses its
native application data directory. Initialization is atomic across concurrent
launches. A corrupt or unreadable identity fails startup rather than silently
creating a different computer. Preserve the file across upgrades, but do not
copy it into machine images or another installation. Reinstalling without its
application data creates a new environment and requires selecting it again.

Rolling back requires retaining backend support while clients with stable IDs
are in use. Older web/worker versions do not understand stable preferences;
do not roll those consumers back independently after adoption.

## Release verification

On the intended Preview deployment, connect the updated CLI, select it, and
complete a bounded Agent request. Stop and restart the runner, return to the
new-task page, reload, and reopen the previous task: the same computer should
remain selected, recover its availability, and complete another request.
Connect a second runner while the first is offline: it must not replace the
selection. Repeat with an updated Desktop build, including local attachments
and a project folder; verify another Desktop installation remains distinct.
Also check an old client and an old saved task. After backend/web/worker
deployment, CLI publication and Desktop promotion are separate release steps.
