#!/bin/sh
# Register hackerai:// protocol handler after deb install.
# Registration is optional, so a stalled helper must not hang dpkg. Without
# --foreground, timeout signals the helper's whole process group, then sends
# SIGKILL one second later if the helper ignores SIGTERM.
if command -v update-desktop-database > /dev/null 2>&1; then
    timeout -k 1s 5s update-desktop-database /usr/share/applications || echo "warn: update-desktop-database failed or timed out" >&2
fi
if command -v xdg-mime > /dev/null 2>&1; then
    timeout -k 1s 5s xdg-mime default co.hackerai.desktop.desktop x-scheme-handler/hackerai || echo "warn: xdg-mime default failed or timed out" >&2
fi
