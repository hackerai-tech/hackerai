"""Compile the Go regressions against the exact probe used by the TLS gate.

Run with Python alongside verify_trust.py and verify_trust_go_test.go, with
the image's pinned Go toolchain on PATH. No network request is made by tests.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from verify_trust import GO_PROBE


def main():
    with tempfile.TemporaryDirectory(prefix="hackerai-go-trust-tests-") as work:
        directory = Path(work)
        source = directory / "probe.go"
        tests = directory / "probe_test.go"
        source.write_text(GO_PROBE)
        shutil.copyfile(Path(__file__).with_name("verify_trust_go_test.go"), tests)
        subprocess.run(
            ["go", "test", "-v", str(source), str(tests)],
            env={
                **os.environ,
                "GOTOOLCHAIN": "local",
                "GOCACHE": str(directory / "go-cache"),
            },
            check=True,
            timeout=120,
        )


if __name__ == "__main__":
    main()
