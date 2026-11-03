"""Exercise package verification with real Debian archives and shell checks."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(shutil.which("dpkg-deb"), "requires Linux Debian package tools")
class BrotliInstallTests(unittest.TestCase):
    def exercise(self, mode="valid", installed="1.2.0-4+b2", headers=True):
        with tempfile.TemporaryDirectory(prefix="brotli-install-test-") as work:
            root = Path(work)
            binaries = root / "bin"
            downloads = root / "downloads"
            binaries.mkdir()
            downloads.mkdir()
            source = Path(__file__).with_name("install_brotli.sh").read_text()
            for name, key in (("libbrotli1", "library"), ("python3-brotli", "python"),
                              ("libbrotli-dev", "development")):
                package = root / name
                (package / "DEBIAN").mkdir(parents=True)
                identity = "unrelated-package" if mode == "wrong_identity_" + name else name
                (package / "DEBIAN/control").write_text(
                    f"Package: {identity}\nVersion: 1.2.0-4.1\nArchitecture: amd64\n"
                    "Maintainer: Test <test@example.invalid>\nDescription: synthetic package\n"
                )
                archive = root / (name + ".deb")
                subprocess.run(["dpkg-deb", "--build", str(package), str(archive)],
                               check=True, capture_output=True)
                digest = hashlib.sha256(archive.read_bytes()).hexdigest()
                source = re.sub(key + r"_sha=[0-9a-f]{64}", key + "_sha=" + digest, source)
            script = root / "install.sh"
            script.write_text(source)
            helpers = {
                "dpkg-query": """
import os, sys
if sys.argv[-1]=='libbrotli-dev' and os.environ['HEADERS']=='no': sys.exit(1)
print(os.environ['INSTALLED'] if sys.argv[-2]=='-f=${Version}' else 'installed')
""",
                "dpkg": """
import json, os, pathlib, subprocess, sys
if sys.argv[1]=='--print-architecture': print('amd64')
elif sys.argv[1]=='--compare-versions':
    sys.exit(subprocess.run([os.environ['REAL_DPKG'], *sys.argv[1:]]).returncode)
else:
    pathlib.Path(os.environ['PROOF']).write_text(json.dumps(sys.argv[1:]))
    if os.environ['MODE']=='install_failure': sys.exit(1)
""",
                "curl": """
import os, pathlib, sys
args=sys.argv[1:]
name=next(arg for arg in args if arg.startswith('https://')).split('/')[-1].split('_')[0]
payload=(pathlib.Path(os.environ['ROOT'])/(name+'.deb')).read_bytes()
mode=os.environ['MODE']
if mode=='corrupt_'+name: payload=payload[:-1]+bytes([payload[-1]^1])
if mode=='truncate_'+name: payload=payload[:8]
pathlib.Path(args[args.index('-o')+1]).write_bytes(payload)
if mode=='download_failure_'+name: sys.exit(22)
""",
            }
            for name, body in helpers.items():
                helper = binaries / name
                helper.write_text(f"#!{sys.executable}\n" + body)
                helper.chmod(0o755)
            proof = root / "proof.json"
            result = subprocess.run(
                ["sh", str(script)], capture_output=True, text=True, timeout=30,
                env={**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                     "ROOT": str(root), "MODE": mode, "INSTALLED": installed,
                     "HEADERS": "yes" if headers else "no", "PROOF": str(proof),
                     "REAL_DPKG": shutil.which("dpkg"), "TMPDIR": str(downloads)},
            )
            invocation = json.loads(proof.read_text()) if proof.exists() else None
            self.assertEqual(list(downloads.iterdir()), [], "downloads were not cleaned")
            return result, invocation

    def test_installs_verified_packages_together_and_keeps_headers_optional(self):
        for headers in (False, True):
            with self.subTest(headers=headers):
                result, invocation = self.exercise(headers=headers)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = {"libbrotli1.deb", "python3-brotli.deb"}
                if headers:
                    expected.add("libbrotli-dev.deb")
                self.assertEqual(invocation[0], "-i")
                self.assertEqual({Path(arg).name for arg in invocation[1:]}, expected)

    def test_corrupt_truncated_failed_or_misidentified_download_never_reaches_installer(self):
        for package in ("libbrotli1", "python3-brotli", "libbrotli-dev"):
            for failure in ("corrupt", "truncate", "download_failure", "wrong_identity"):
                with self.subTest(package=package, failure=failure):
                    result, invocation = self.exercise(failure + "_" + package)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIsNone(invocation)

    def test_preserves_fixed_and_newer_packages(self):
        for version in ("1.2.0-4.1", "1.2.1-1"):
            with self.subTest(version=version):
                result, invocation = self.exercise(installed=version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(invocation)

    def test_install_failure_is_not_hidden_and_cleans_downloads(self):
        result, invocation = self.exercise("install_failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNotNone(invocation)


if __name__ == "__main__":
    unittest.main()
