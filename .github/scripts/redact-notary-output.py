#!/usr/bin/env python3
"""Stream notarytool output without exposing its authentication values."""

import os
import sys


def main():
    credentials = sorted(
        {
            os.environ.get(name, "")
            for name in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID")
        }
        - {""},
        key=len,
        reverse=True,
    )
    for line in sys.stdin:
        for value in credentials:
            line = line.replace(value, "***")
        print(line, end="", flush=True)


if __name__ == "__main__":
    main()
