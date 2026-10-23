"""Exercise the Dockerfile bootstrap with controlled downloads and real hashes."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


PINS = {
    "pip": ("fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70", b"pip wheel fixture"),
    "certifi": ("42d35340cc5b9ba78e818ddbff0c5b1c2b779de448a340fd1b989f5fa8670e1b", b"certifi wheel fixture"),
}


def bootstrap_run():
    """Read the production RUN instruction, including the pre-fix form."""
    source = Path(os.environ.get("BOOTSTRAP_DOCKERFILE", Path(__file__).with_name("Dockerfile")))
    instructions, current = [], ""
    for line in source.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        continued = line.rstrip().endswith("\\")
        current += " " + (line.rstrip()[:-1] if continued else line)
        if not continued:
            instructions.append(current.strip())
            current = ""
    return next(run[4:] for run in instructions if run.startswith("RUN ") and
                ("pip==26.2.2" in run or "pip-26.2.2-py3-none-any.whl" in run))


class PipBootstrapTests(unittest.TestCase):
    def exercise(self, mode="valid"):
        with tempfile.TemporaryDirectory(prefix="pip-bootstrap-test-") as work:
            directory = Path(work)
            binaries = directory / "bin"
            downloads = directory / "downloads"
            binaries.mkdir()
            downloads.mkdir()
            proof = directory / "install.json"
            for name, (_, payload) in PINS.items():
                (directory / name).write_bytes(payload)
            # Only external I/O is replaced. The actual RUN, shell failure
            # handling, checksum utility and cleanup all execute unchanged.
            curl = binaries / "curl"
            curl.write_text(f"#!{sys.executable}\n" + """
import os, pathlib, sys
arguments=sys.argv[1:]
url=next(arg for arg in arguments if arg.startswith('https://'))
package='certifi' if '/certifi-' in url else 'pip'
target=pathlib.Path(arguments[arguments.index('-o')+1])
payload=(pathlib.Path(os.environ['FIXTURE_ROOT'])/package).read_bytes()
mode=os.environ['FIXTURE_MODE']
if mode=='corrupt_'+package: payload=payload[:-1]+b'!'
if mode=='truncate_'+package: payload=payload[:3]
target.write_bytes(payload)
if mode=='download_failure_'+package: sys.exit(22)
""")
            installer = binaries / "python3"
            installer.write_text(f"#!{sys.executable}\n" + """
import json, os, pathlib, sys
pathlib.Path(os.environ['INSTALL_PROOF']).write_text(json.dumps(sys.argv[1:]))
if os.environ['FIXTURE_MODE']=='install_failure': sys.exit(1)
""")
            curl.chmod(0o755)
            installer.chmod(0o755)
            command = bootstrap_run()
            for checksum, payload in PINS.values():
                command = command.replace(checksum, hashlib.sha256(payload).hexdigest())
            result = subprocess.run(
                ["/bin/sh", "-c", command],
                env={**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                     "TMPDIR": str(downloads), "FIXTURE_ROOT": str(directory),
                     "FIXTURE_MODE": mode, "INSTALL_PROOF": str(proof)},
                capture_output=True, text=True, timeout=15,
            )
            invocation = json.loads(proof.read_text()) if proof.exists() else None
            self.assertEqual(list(downloads.iterdir()), [], "temporary downloads were retained")
            return result, invocation

    def test_verified_wheels_are_installed_offline_without_touching_distro_packages(self):
        result, invocation = self.exercise()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNotNone(invocation)
        self.assertEqual(invocation[:3], ["-m", "pip", "install"])
        for option in ("--no-index", "--no-deps", "--ignore-installed", "--break-system-packages", "--no-cache-dir", "--disable-pip-version-check"):
            self.assertIn(option, invocation)
        wheels = [arg for arg in invocation if arg.endswith(".whl")]
        self.assertEqual([Path(arg).name for arg in wheels], ["pip-26.2.2-py3-none-any.whl", "certifi-2026.10.19-py3-none-any.whl"])
        self.assertTrue(all(Path(arg).is_absolute() for arg in wheels))
        self.assertFalse(any(arg.startswith("https://") for arg in invocation))

    def test_tampered_or_truncated_downloads_stop_before_any_installation(self):
        for package in PINS:
            for attack in ("corrupt", "truncate"):
                with self.subTest(package=package, attack=attack):
                    result, invocation = self.exercise(attack + "_" + package)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIsNone(invocation, "unverified download reached the installer")

    def test_failed_downloads_stop_before_any_installation(self):
        for package in PINS:
            with self.subTest(package=package):
                result, invocation = self.exercise("download_failure_" + package)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(invocation)

    def test_installation_failure_still_cleans_verified_downloads(self):
        result, invocation = self.exercise("install_failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNotNone(invocation)


if __name__ == "__main__":
    unittest.main()
