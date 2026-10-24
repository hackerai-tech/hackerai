"""Fail image builds when any supported TLS client still trusts the test CAs."""

import concurrent.futures
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request


TARGETS = (
    ("https://example.com/", "accepted"),
    ("https://dv-g3b-emudhra.we-have-a-problem.com/", "certificate_rejected"),
    ("https://dv-g3b-aaa-emudhra.we-have-a-problem.com/", "certificate_rejected"),
)
# Roots distrusted by Debian's eMudhra emergency update. Identify certificate
# contents, not filenames, so unrelated custom and E2B proxy CAs stay intact.
DISTRUSTED_ROOT_SHA256 = {
    "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
    "d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4",
}
NODE_PROBE = r"""
const https = require('node:https');
const certificateErrors = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_REVOKED', 'CERT_UNTRUSTED',
]);
const request = https.get(process.argv[1], response => {
  console.log(JSON.stringify({outcome: 'accepted', status: response.statusCode}));
  response.resume();
});
request.setTimeout(12000, () => request.destroy(new Error('TLS probe timed out')));
request.on('error', error => console.log(JSON.stringify({
  outcome: certificateErrors.has(error.code) ? 'certificate_rejected' : 'error',
  detail: error.code || error.message,
})));
"""
GO_PROBE = r"""
package main
import ("crypto/x509"; "encoding/json"; "errors"; "fmt"; "net/http"; "os"; "time")
func certificateRejected(err error) bool {
  var unknown x509.UnknownAuthorityError
  var invalid x509.CertificateInvalidError
  return errors.As(err, &unknown) || (errors.As(err, &invalid) && invalid.Reason == x509.NoValidChains && invalid.Detail == "")
}
func main() {
  client := http.Client{Timeout: 12*time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
  result := map[string]interface{}{}
  response, err := client.Get(os.Args[1])
  if err == nil {
    result["outcome"] = "accepted"
    result["status"] = response.StatusCode
    response.Body.Close()
  } else {
    result["outcome"] = "error"
    if certificateRejected(err) { result["outcome"] = "certificate_rejected" }
    result["detail"] = err.Error()
  }
  output, _ := json.Marshal(result)
  fmt.Println(string(output))
}
"""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def distrusted_entries(directory):
    for path in directory.iterdir():
        if not (path.name.endswith(".pem") or re.fullmatch(r"[0-9a-f]{8}\.[0-9]+", path.name)):
            continue
        if not path.is_file():
            continue
        content = path.read_text(encoding="ascii")
        certificates = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", content, re.S)
        # Never remove an unrelated bundle just because it contains a root.
        if len(certificates) != 1:
            continue
        digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificates[0])).hexdigest()
        if digest in DISTRUSTED_ROOT_SHA256:
            yield path


def refresh_system_trust(directory=Path("/etc/ssl/certs"), seed=Path("/usr/local/share/e2b/ssl-certs.tar")):
    # update-ca-certificates --fresh removes symlinks, but E2B's tar -h boot
    # seed turns them into regular files. Stale hash files can still authorize
    # a CA absent from the rebuilt bundle through OpenSSL's lazy CApath lookup.
    removed = list(distrusted_entries(directory))
    for path in removed:
        path.unlink()
    subprocess.run(["update-ca-certificates", "--fresh"], check=True)
    if list(distrusted_entries(directory)):
        raise RuntimeError("Distrusted roots remain after the CA refresh")
    if seed.is_file():
        # Match E2B's dereferenced, uncompressed boot archive, replacing it
        # atomically so later layer boots cannot restore the stale hash files.
        with tempfile.NamedTemporaryFile(dir=seed.parent, prefix=".ssl-certs-", delete=False) as output:
            temporary = Path(output.name)
        try:
            with tarfile.open(temporary, "w", dereference=True, format=tarfile.GNU_FORMAT) as archive:
                archive.add(directory, arcname=".")
            temporary.chmod(0o644)
            temporary.replace(seed)
        finally:
            temporary.unlink(missing_ok=True)
    print(json.dumps({"removed_distrusted_ca_entries": len(removed), "e2b_seed_refreshed": seed.is_file()}), flush=True)


def certificate_rejected(error):
    """Require a CA-chain rejection; DNS, timeouts and expiry are not proof."""
    pending, seen = [error], set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, ssl.SSLCertVerificationError):
            # OpenSSL: self-signed, missing issuer, revoked, or untrusted CA.
            return current.verify_code in (18, 19, 20, 21, 23, 27)
        for attr in ("reason", "__cause__", "__context__"):
            nested = getattr(current, attr, None)
            if isinstance(nested, BaseException):
                pending.append(nested)
        pending.extend(x for x in getattr(current, "args", ()) if isinstance(x, BaseException))
    return False


def run_json(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=18, check=True)
    return json.loads(result.stdout)


def probe(client, url, go_binary):
    try:
        if client == "curl":
            result = subprocess.run(
                ["curl", "--disable", "--silent", "--show-error", "--output", "/dev/null",
                 "--write-out", "%{http_code} %{ssl_verify_result}",
                 "--connect-timeout", "8", "--max-time", "15", url],
                capture_output=True, text=True, timeout=18,
            )
            status, verify_code = (int(value) for value in result.stdout.split())
            if result.returncode == 0:
                return {"outcome": "accepted", "status": status}
            rejected = result.returncode == 60 and verify_code in (18, 19, 20, 21, 23, 27)
            return {"outcome": "certificate_rejected" if rejected else "error",
                    "verify_code": verify_code, "detail": result.stderr[:300]}
        if client == "node":
            return run_json(["node", "-e", NODE_PROBE, url])
        if client == "go":
            return run_json([str(go_binary), url])
        if client == "requests":
            import requests
            response = requests.get(url, timeout=12, allow_redirects=False)
            return {"outcome": "accepted", "status": response.status_code}
        if client == "httpx":
            import httpx
            response = httpx.get(url, timeout=12, follow_redirects=False)
            return {"outcome": "accepted", "status": response.status_code}
        if client == "pip_bundle":
            from pip._vendor import certifi
            context = ssl.create_default_context(cafile=certifi.where())
        elif client == "python_ssl":
            context = ssl.create_default_context()
        else:
            raise ValueError(f"Unknown TLS client: {client}")
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), NoRedirect())
        with opener.open(url, timeout=12) as response:
            return {"outcome": "accepted", "status": response.status}
    except urllib.error.HTTPError as error:
        # HTTP errors still prove that the TLS connection was accepted.
        return {"outcome": "accepted", "status": error.code}
    except Exception as error:
        return {"outcome": "certificate_rejected" if certificate_rejected(error) else "error",
                "detail": str(error)[:300]}


def passed(result, expected):
    if result.get("outcome") != expected:
        return False
    return expected != "accepted" or 200 <= result.get("status", 0) < 400


def main(refresh=False):
    for name in ("NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
                 "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "HTTPS_PROXY",
                 "https_proxy", "ALL_PROXY", "all_proxy"):
        if os.environ.get(name):
            raise RuntimeError(f"TLS gate requires the image's default trust stores: unset {name}")
    for package, version in (("pip", "26.2.2"), ("certifi", "2026.10.19")):
        if importlib.metadata.version(package) != version:
            raise RuntimeError(f"Expected {package} {version}")
    if refresh:
        refresh_system_trust()

    with tempfile.TemporaryDirectory(prefix="hackerai-trust-") as work:
        source, binary = Path(work) / "probe.go", Path(work) / "probe"
        source.write_text(GO_PROBE)
        env = {**os.environ, "GOCACHE": str(Path(work) / "go-cache"), "GOTOOLCHAIN": "local"}
        subprocess.run(["go", "build", "-o", str(binary), str(source)], env=env, check=True, timeout=120)
        clients = ("curl", "node", "python_ssl", "requests", "httpx", "pip_bundle", "go")
        failures = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            jobs = [(client, url, expected, pool.submit(probe, client, url, binary))
                    for client in clients for url, expected in TARGETS]
            for client, url, expected, job in jobs:
                result = job.result()
                ok = passed(result, expected)
                print(json.dumps({"client": client, "url": url, "passed": ok, **result}), flush=True)
                if not ok:
                    failures.append(f"{client}: {url}")
        if failures:
            raise RuntimeError("TLS trust gate failed: " + "; ".join(failures))
        print("TLS trust gate passed: all clients reject both test CAs and accept normal HTTPS.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-system-trust", action="store_true")
    main(refresh=parser.parse_args().refresh_system_trust)
