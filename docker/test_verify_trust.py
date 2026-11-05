import ssl
import contextlib
import io
import hashlib
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import verify_trust


class TrustGateTests(unittest.TestCase):
    def test_materialized_ca_copies_are_removed_and_boot_seed_is_repaired(self):
        retired = ssl.DER_cert_to_PEM_cert(b"retired CA DER")
        custom = ssl.DER_cert_to_PEM_cert(b"unrelated custom CA DER")
        digest = hashlib.sha256(b"retired CA DER").hexdigest()
        with tempfile.TemporaryDirectory() as work:
            directory = Path(work) / "certs"
            directory.mkdir()
            (directory / "retired.pem").write_text(retired)
            (directory / "14bc7599.0").write_text(retired)
            source = Path(work) / "retired-source.crt"
            source.write_text(retired)
            (directory / "14bc7599.1").symlink_to(source)
            (directory / "provider.pem").write_text(custom)
            (directory / "bundle.pem").write_text(custom + retired)
            (directory / "java").mkdir()
            (directory / "java" / "cacerts").write_bytes(b"preserved keystore")
            seed = Path(work) / "ssl-certs.tar"
            seed.write_bytes(b"old boot seed")
            with patch.object(verify_trust, "DISTRUSTED_ROOT_SHA256", {digest}), \
                 patch("subprocess.run") as update, contextlib.redirect_stdout(io.StringIO()):
                verify_trust.refresh_system_trust(directory, seed)
                update.assert_called_once_with(["update-ca-certificates", "--fresh"], check=True)
                self.assertEqual(list(verify_trust.distrusted_entries(directory)), [])
                verify_trust.refresh_system_trust(directory, seed)  # Idempotent.
            self.assertEqual(source.read_text(), retired)
            self.assertEqual((directory / "provider.pem").read_text(), custom)
            self.assertEqual((directory / "bundle.pem").read_text(), custom + retired)
            with tarfile.open(seed) as archive:
                self.assertEqual(archive.extractfile("./provider.pem").read().decode(), custom)
                self.assertEqual(archive.extractfile("./java/cacerts").read(), b"preserved keystore")
                self.assertNotIn("./14bc7599.0", archive.getnames())
                self.assertNotIn("./14bc7599.1", archive.getnames())
                self.assertNotIn("./retired.pem", archive.getnames())

    def test_curl_requires_ca_rejection_and_not_just_exit_60(self):
        for exit_code, output, expected in (
            (0, "200 0", "accepted"),
            (60, "000 20", "certificate_rejected"),
            (60, "000 23", "certificate_rejected"),
            (60, "000 10", "error"),  # Expired trusted certificate.
            (60, "000 62", "error"),  # Hostname mismatch.
            (28, "000 0", "error"),   # Timeout.
            (60, "invalid output", "error"),
        ):
            with self.subTest(exit_code=exit_code, output=output):
                completed = subprocess.CompletedProcess([], exit_code, stdout=output, stderr="TLS failure")
                with patch("subprocess.run", return_value=completed):
                    self.assertEqual(verify_trust.probe("curl", "https://example.com/", None)["outcome"], expected)

    def test_trusting_either_advisory_host_fails(self):
        for url, expected in verify_trust.TARGETS[1:]:
            with self.subTest(url=url):
                self.assertFalse(verify_trust.passed({"outcome": "accepted", "status": 200}, expected))
                self.assertFalse(verify_trust.passed({"outcome": "accepted", "status": 403}, expected))

    def test_network_failures_are_never_success(self):
        for expected in ("accepted", "certificate_rejected"):
            self.assertFalse(verify_trust.passed({"outcome": "error"}, expected))

    def test_control_must_succeed(self):
        self.assertTrue(verify_trust.passed({"outcome": "accepted", "status": 200}, "accepted"))
        self.assertFalse(verify_trust.passed({"outcome": "certificate_rejected"}, "accepted"))
        self.assertFalse(verify_trust.passed({"outcome": "accepted", "status": 503}, "accepted"))

    def test_ca_error_is_found_inside_client_wrappers(self):
        error = ssl.SSLCertVerificationError(1, "certificate verify failed")
        error.verify_code = 20
        wrapped = RuntimeError(RuntimeError(error))
        self.assertTrue(verify_trust.certificate_rejected(wrapped))
        error.verify_code = 10  # Expiry alone does not prove CA distrust.
        self.assertFalse(verify_trust.certificate_rejected(wrapped))
        self.assertFalse(verify_trust.certificate_rejected(TimeoutError()))
        self.assertFalse(verify_trust.certificate_rejected(ConnectionRefusedError()))

    def test_python_probe_distinguishes_network_and_ca_errors(self):
        error = ssl.SSLCertVerificationError(1, "certificate verify failed")
        error.verify_code = 20
        for cause, expected in ((error, "certificate_rejected"), (TimeoutError(), "error")):
            with self.subTest(cause=type(cause).__name__):
                with patch("urllib.request.OpenerDirector.open", side_effect=verify_trust.urllib.error.URLError(cause)):
                    self.assertEqual(verify_trust.probe("python_ssl", "https://example.com/", None)["outcome"], expected)

    def test_redirect_does_not_hide_an_accepted_tls_connection(self):
        redirect = verify_trust.urllib.error.HTTPError("https://example.com/", 302, "redirect", {}, None)
        with patch("urllib.request.OpenerDirector.open", side_effect=redirect):
            result = verify_trust.probe("python_ssl", "https://example.com/", None)
        self.assertEqual(result, {"outcome": "accepted", "status": 302})

    def test_complete_gate_fails_for_one_unsafe_client_or_network_error(self):
        for host, failure in ((verify_trust.TARGETS[1][0], {"outcome": "accepted", "status": 200}),
                              (verify_trust.TARGETS[2][0], {"outcome": "accepted", "status": 403}),
                              (verify_trust.TARGETS[1][0], {"outcome": "error"})):
            def fake_probe(client, url, binary):
                if client == "node" and url == host:
                    return failure
                return {"outcome": "accepted", "status": 200} if url == verify_trust.TARGETS[0][0] else {"outcome": "certificate_rejected"}

            with self.subTest(host=host, failure=failure):
                with patch.dict("os.environ", {}, clear=True), \
                     patch("importlib.metadata.version", side_effect=lambda name: {"pip": "26.2.2", "certifi": "2026.10.19"}[name]), \
                     patch("subprocess.run"), patch.object(verify_trust, "probe", side_effect=fake_probe), \
                     contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError, "TLS trust gate failed"):
                        verify_trust.main()


if __name__ == "__main__":
    unittest.main()
