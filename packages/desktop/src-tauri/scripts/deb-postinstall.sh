#!/bin/sh
# Register hackerai:// protocol handler after deb install
if command -v update-desktop-database > /dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
if command -v xdg-mime > /dev/null 2>&1; then
    xdg-mime default hackerai.desktop x-scheme-handler/hackerai || true
fi
