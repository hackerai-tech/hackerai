"""Exercise the release helpers with fake Apple tools and disposable bytes."""

import hashlib
import os
from pathlib import Path
import select
import signal
import subprocess
import tarfile
import tempfile
import textwrap
import time
import unittest


SCRIPTS = Path(__file__).resolve().parent
SUBMISSION_ID = "12345678-1234-1234-1234-123456789abc"


class NotaryRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.dmg = self.root / "input.dmg"
        self.dmg.write_bytes(b"disposable signed DMG fixture\x00\xff")
        self.log = self.root / "notary.txt"
        self.actions = self.root / "actions.txt"
        self.env = dict(os.environ, PATH=f"{self.root}:{os.environ['PATH']}")
        self.env.update(
            APPLE_ID="fixture-apple-id",
            APPLE_PASSWORD="fixture-password",
            APPLE_TEAM_ID="fixture-team",
            GITHUB_SHA="a" * 40,
            GITHUB_RUN_ID="123",
            GITHUB_RUN_ATTEMPT="2",
            FIXTURE_ACTIONS=str(self.actions),
            FIXTURE_MODE="accepted",
        )
        self.credentials = [self.env[key] for key in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID")]
        self.tool("xcrun", """
            import os, sys, time
            from pathlib import Path
            command = " ".join(sys.argv[1:3])
            with Path(os.environ["FIXTURE_ACTIONS"]).open("a") as actions:
                actions.write(command + "\\n")
            if command == "notarytool submit":
                print("id: 12345678-1234-1234-1234-123456789abc", flush=True)
                print(" ".join(os.environ[key] for key in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID")), flush=True)
                if os.environ["FIXTURE_MODE"] == "waiting":
                    time.sleep(30)
                sys.exit(1 if os.environ["FIXTURE_MODE"] == "rejected" else 0)
            if command == "notarytool log":
                print(os.environ["APPLE_PASSWORD"], file=sys.stderr, flush=True)
            if command == "stapler staple" and os.environ["FIXTURE_MODE"] == "staple-failed":
                sys.exit(1)
        """)
        self.tool("spctl", """
            import os
            from pathlib import Path
            with Path(os.environ["FIXTURE_ACTIONS"]).open("a") as actions:
                actions.write("assess\\n")
        """)

    def tool(self, name, source):
        path = self.root / name
        path.write_text("#!/usr/bin/env python3\n" + textwrap.dedent(source))
        path.chmod(0o700)

    def notarize(self, mode):
        self.env["FIXTURE_MODE"] = mode
        return subprocess.run(
            ["bash", str(SCRIPTS / "notarize-universal-dmg.sh"), str(self.dmg), str(self.log)],
            env=self.env, capture_output=True, text=True, timeout=10,
        )

    def assert_redacted(self, output):
        for credential in self.credentials:
            self.assertNotIn(credential, output)

    def test_accepted_submission_staples_and_redacts(self):
        result = self.notarize("accepted")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(SUBMISSION_ID, result.stdout)
        self.assert_redacted(result.stdout + result.stderr + self.log.read_text())
        self.assertEqual(self.log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.actions.read_text().splitlines(), ["notarytool submit", "stapler staple", "assess"])

    def test_rejected_submission_cannot_staple(self):
        result = self.notarize("rejected")
        self.assertNotEqual(result.returncode, 0)
        self.assert_redacted(result.stdout + result.stderr + self.log.read_text())
        self.assertEqual(self.actions.read_text().splitlines(), ["notarytool submit", "notarytool log"])

    def test_stapling_failure_is_fatal(self):
        result = self.notarize("staple-failed")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("assess", self.actions.read_text())

    def test_missing_credentials_cannot_submit(self):
        del self.env["APPLE_PASSWORD"]
        result = self.notarize("accepted")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.actions.exists())

    def test_submission_id_survives_interrupted_wait(self):
        self.env["FIXTURE_MODE"] = "waiting"
        process = subprocess.Popen(
            ["bash", str(SCRIPTS / "notarize-universal-dmg.sh"), str(self.dmg), str(self.log)],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        )
        output = b""
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and SUBMISSION_ID.encode() not in output:
                if select.select([process.stdout], [], [], 0.2)[0]:
                    chunk = os.read(process.stdout.fileno(), 4096)
                    if not chunk:
                        break
                    output += chunk
            self.assertIsNone(process.poll(), "submission should still be waiting")
            self.assertIn(SUBMISSION_ID.encode(), output, "ID must reach stdout before the wait finishes")
            self.assertIn(SUBMISSION_ID, self.log.read_text())
        finally:
            os.killpg(process.pid, signal.SIGTERM)
            remaining, _ = process.communicate(timeout=5)
            output += remaining
        self.assert_redacted(output.decode() + self.log.read_text())
        self.assertNotIn("stapler", self.actions.read_text())

    def archive(self):
        archive = self.root / "universal-notary-recovery.tar.gz"
        result = subprocess.run(
            ["bash", str(SCRIPTS / "archive-universal-dmg.sh"), str(self.dmg), str(archive)],
            env=self.env, capture_output=True, text=True, timeout=10,
        )
        return result, archive

    def test_recovery_retains_exact_bytes_and_provenance(self):
        result, archive = self.archive()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(archive) as packed:
            contents = {member.name: packed.extractfile(member).read() for member in packed.getmembers()}
        self.assertEqual(contents["HackerAI-universal.dmg"], self.dmg.read_bytes())
        self.assertEqual(contents["HackerAI-universal.dmg.sha256"].decode().split()[0], hashlib.sha256(self.dmg.read_bytes()).hexdigest())
        self.assertEqual(contents["source-commit.txt"], b"a" * 40 + b"\n")
        self.assertEqual(contents["build-run.txt"], b"123/2\n")

    def test_invalid_source_cannot_create_recovery_archive(self):
        self.env["GITHUB_SHA"] = "unverified"
        result, archive = self.archive()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(archive.exists())

    def test_pending_recovery_cannot_replace_notarized_release_artifact(self):
        result, archive = self.archive()
        self.assertEqual(result.returncode, 0, result.stderr)
        artifacts = self.root / "artifacts"
        recovery = artifacts / "notarization-recovery-universal-attempt-2"
        recovery.mkdir(parents=True)
        archive.rename(recovery / archive.name)
        for arch in ("arm64", "x64"):
            directory = artifacts / f"desktop-macOS-{arch}"
            directory.mkdir()
            suffix = "aarch64" if arch == "arm64" else "x64"
            (directory / f"HackerAI_0.0.70_{suffix}.dmg").write_bytes(b"fixture")
        result = subprocess.run(
            ["bash", str(SCRIPTS / "prepare-desktop-release.sh"), str(artifacts), str(self.root / "release"), "0.0.70", "desktop-v0.0.70", "fixture/repo"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("desktop-macOS-universal", result.stderr)
        self.assertFalse((self.root / "release" / "HackerAI-universal.dmg").exists())
        # The tag-release collector searches downloaded files without unpacking
        # arbitrary tarballs. Its installer globs must not match recovery bytes.
        for pattern in ("*.dmg", "*.app.tar.gz", "*.AppImage", "*.exe"):
            self.assertEqual(list(recovery.rglob(pattern)), [])


if __name__ == "__main__":
    unittest.main()
