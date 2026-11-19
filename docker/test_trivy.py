"""Verify the installer rejects unsafe downloads before installing a scanner."""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


@unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux install and sha256sum")
class TrivyInstallTests(unittest.TestCase):
    def exercise(self, mode="valid", arch="x86_64"):
        with tempfile.TemporaryDirectory(prefix="trivy-install-test-") as work:
            root = Path(work)
            helpers = root / "helpers"
            downloads = root / "downloads"
            destination = root / "installed"
            for directory in (helpers, downloads, destination):
                directory.mkdir()
            archive = root / "fixture.tar.gz"
            with tarfile.open(archive, "w:gz") as output:
                members = {"LICENSE": b"Synthetic test license\n"}
                if mode != "missing_binary":
                    members["trivy"] = (b"#!/bin/sh\nexit 1\n" if mode == "broken_binary"
                                        else b"#!/bin/sh\necho 'Version: 0.76.2'\n")
                for name, contents in members.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(contents)
                    info.mode = 0o755 if name == "trivy" else 0o644
                    output.addfile(info, io.BytesIO(contents))
            source = Path(__file__).with_name("install_trivy.sh").read_text()
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            source = re.sub(r"checksum=[0-9a-f]{64}", "checksum=" + digest, source)
            script = root / "install.sh"
            script.write_text(source)
            bodies = {
                "uname": "import os\nprint(os.environ['TEST_ARCH'])\n",
                "curl": """
import json, os, pathlib, sys
root = pathlib.Path(os.environ['TEST_ROOT'])
(root/'curl.json').write_text(json.dumps(sys.argv[1:]))
content = (root/'fixture.tar.gz').read_bytes()
if os.environ['TEST_MODE']=='corrupt': content += b'changed'
if os.environ['TEST_MODE']=='truncated': content = content[:8]
pathlib.Path(sys.argv[sys.argv.index('-o')+1]).write_bytes(content)
if os.environ['TEST_MODE']=='download_failure': sys.exit(22)
""",
                "install": """
import json, os, pathlib, subprocess, sys
root = pathlib.Path(os.environ['TEST_ROOT'])
with (root/'install.jsonl').open('a') as log: log.write(json.dumps(sys.argv[1:])+'\\n')
if os.environ['TEST_MODE']=='install_failure': sys.exit(1)
args = sys.argv[1:]
args[-1] = str(root/'installed'/pathlib.Path(args[-1]).name)
sys.exit(subprocess.run([os.environ['REAL_INSTALL'], *args]).returncode)
""",
            }
            for name, body in bodies.items():
                helper = helpers / name
                helper.write_text(f"#!{sys.executable}\n" + body)
                helper.chmod(0o755)
            result = subprocess.run(
                ["sh", str(script)], capture_output=True, text=True, timeout=30,
                env={**os.environ, "PATH": str(helpers) + os.pathsep + os.environ["PATH"],
                     "TMPDIR": str(downloads), "TEST_ROOT": str(root), "TEST_MODE": mode,
                     "TEST_ARCH": arch, "REAL_INSTALL": shutil.which("install")},
            )
            self.assertEqual(list(downloads.iterdir()), [], "temporary archives were retained")
            fetched = json.loads((root / "curl.json").read_text()) if (root / "curl.json").exists() else None
            installed = {f.name: (f.read_bytes(), f.stat().st_mode & 0o777)
                         for f in destination.iterdir()}
            return result, fetched, installed, (root / "install.jsonl").exists()

    def test_supported_architectures_install_verified_binary_and_license(self):
        for arch, platform in (("x86_64", "64bit"), ("aarch64", "ARM64"), ("arm64", "ARM64")):
            with self.subTest(arch=arch):
                result, fetched, installed, _ = self.exercise(arch=arch)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"https://github.com/aquasecurity/trivy/releases/download/v0.76.2/trivy_0.76.2_Linux-{platform}.tar.gz", fetched)
                self.assertEqual(set(installed), {"trivy", "LICENSE"})
                self.assertEqual(installed["trivy"][1], 0o755)
                self.assertEqual(installed["LICENSE"], (b"Synthetic test license\n", 0o644))

    def test_invalid_download_never_reaches_install(self):
        for mode in ("corrupt", "truncated", "download_failure", "missing_binary", "broken_binary"):
            with self.subTest(mode=mode):
                result, _, installed, attempted = self.exercise(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(attempted)
                self.assertEqual(installed, {})

    def test_unsupported_architecture_rejects_before_download(self):
        result, fetched, installed, attempted = self.exercise(arch="s390x")
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(fetched)
        self.assertFalse(attempted)
        self.assertEqual(installed, {})

    def test_install_failure_fails_build_and_cleans_download(self):
        result, _, installed, attempted = self.exercise("install_failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(attempted)
        self.assertEqual(installed, {})


if __name__ == "__main__":
    unittest.main()
