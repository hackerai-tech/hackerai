#!/bin/sh
# Register hackerai:// protocol handler after deb install.
# Registration is optional, so a stalled helper must not hang dpkg. Each helper
# gets a hard 5-second deadline. Without --foreground, timeout runs in its own
# process group and sends SIGTERM to that group at the deadline. The wrapper
# shell answers SIGTERM by sending SIGKILL to timeout's group: timeout, itself,
# the helper and any helper children. This script stays outside that group and
# continues with a warning. The -k 1s SIGKILL is only a fallback for the
# monitored process; some timeout implementations do not deliver it to the
# group, so the wrapper is what removes the helper's children.
# Address timeout's group explicitly, never the installer's inherited group.
run_registration() {
    timeout -k 1s 5s /bin/sh -c '
        trap "kill -s KILL -- -$PPID" TERM
        "$@" &
        wait "$!"
    ' sh "$@"
}

if command -v update-desktop-database > /dev/null 2>&1; then
    run_registration update-desktop-database /usr/share/applications || echo "warn: update-desktop-database failed or timed out" >&2
fi
if command -v xdg-mime > /dev/null 2>&1; then
    run_registration xdg-mime default co.hackerai.desktop.desktop x-scheme-handler/hackerai || echo "warn: xdg-mime default failed or timed out" >&2
fi
