"""Dante + PAM integration for pam_hackerai_egress and the collector.

Runs as root inside the image built from scripts/egress/tests/Dockerfile with
``--network none``: distro Dante authenticates through the real PAM stack in
scripts/egress/hackerai-egress.pam to a loopback HTTP target. Only synthetic
fixture credentials are used; nothing leaves the container's loopback.

Syslog is captured on a test /dev/log socket and replayed to the collector as
journal JSON, since the container has no journald.
"""

import http.server
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
import collector  # noqa: E402
from test_collector import Sink  # noqa: E402

FIXTURE = json.loads((HERE / "credentials.json").read_text())
US1, US2, EU1 = FIXTURE["vectors"]
LEGACY = FIXTURE["legacy"]
LOCAL_RESERVED = FIXTURE["reservedLocalUser"]
OTHER_LOCAL = FIXTURE["otherLocalUser"]
KEY_DIR = Path("/etc/hackerai-egress")
KEY_FILE = KEY_DIR / "attribution.key"
PAM_SERVICE = Path("/etc/pam.d/hackerai-egress")
DANTE_CONF = Path("/etc/hackerai-egress-test-danted.conf")
DANTE_LOG = Path("/tmp/danted.log")
SOCKS_PORT = 1080
TARGET_PORT = 8080
TARGET_BODY = b"hackerai-egress-loopback-target"
NOBODY = 65534
SECRETS = [v["password"] for v in FIXTURE["vectors"]] + [
    LEGACY["password"],
    LOCAL_RESERVED["password"],
    OTHER_LOCAL["password"],
    *FIXTURE["attributionKeys"].values(),
]

DANTE = f"""logoutput: stderr
internal: 127.0.0.1 port = {SOCKS_PORT}
external: 127.0.0.1
socksmethod: pam.username
clientmethod: none
user.privileged: root
user.unprivileged: nobody
client pass {{
  from: 127.0.0.0/8 to: 0.0.0.0/0
}}
socks pass {{
  from: 127.0.0.0/8 to: 127.0.0.1/32 port = {TARGET_PORT}
  command: connect
  protocol: tcp
  socksmethod: pam.username
  pam.servicename: hackerai-egress
}}
socks block {{
  from: 0.0.0.0/0 to: 0.0.0.0/0
}}
"""

failures = []


def check(condition, label):
    print(("PASS " if condition else "FAIL ") + label, flush=True)
    if not condition:
        failures.append(label)


class SyslogCapture:
    """Stands in for journald's /dev/log so module output can be inspected."""

    def __init__(self):
        try:
            os.unlink("/dev/log")
        except FileNotFoundError:
            pass
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.sock.bind("/dev/log")
        os.chmod("/dev/log", 0o666)
        self.records = []
        self.lock = threading.Lock()
        threading.Thread(target=self._receive, daemon=True).start()

    def _receive(self):
        while True:
            data = self.sock.recv(65536)
            match = re.match(rb"<(\d{1,3})>(.{15}) (.*)", data, re.S)
            if not match:
                continue
            tag_and_message = match.group(3)
            _, _, message = tag_and_message.partition(b": ")
            with self.lock:
                self.records.append(
                    {
                        "facility": int(match.group(1)) >> 3,
                        "message": message.decode("utf-8", "replace").rstrip("\n"),
                        "raw": data,
                        "at": time.time(),
                    }
                )

    def mark(self):
        with self.lock:
            return len(self.records)

    def since(self, mark, settle=0.3):
        time.sleep(settle)
        with self.lock:
            return list(self.records[mark:])


class Target(http.server.BaseHTTPRequestHandler):
    hits = 0

    def do_GET(self):
        Target.hits += 1
        self.send_response(200)
        self.send_header("Content-Length", str(len(TARGET_BODY)))
        self.end_headers()
        self.wfile.write(TARGET_BODY)

    def log_message(self, *args):
        pass


def recv_exact(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


# Dante answers the RFC 1929 exchange before it evaluates pam.username: PAM
# runs while matching the socks rule, which names the PAM service. A PAM
# failure therefore arrives as SOCKS5 reply 0x02, "connection not allowed by
# ruleset", after a successful subnegotiation. A subnegotiation failure is
# also an authentication denial. Anything else is reported by name.
DENIED = {"auth_rejected", "request_rejected:2"}


def socks_fetch(username, password):
    """SOCKS5 username/password CONNECT to the loopback target. Returns "ok"
    or the exact stage and code where the exchange stopped."""
    user = username.encode()
    secret = password.encode()
    stage = "connect"
    try:
        with socket.create_connection(("127.0.0.1", SOCKS_PORT), timeout=10) as sock:
            stage = "method"
            sock.sendall(b"\x05\x01\x02")
            method = recv_exact(sock, 2)
            if method != b"\x05\x02":
                return f"method_rejected:{method.hex()}"
            stage = "auth"
            sock.sendall(b"\x01" + bytes([len(user)]) + user + bytes([len(secret)]) + secret)
            status = recv_exact(sock, 2)
            if status[1] != 0:
                return "auth_rejected"
            stage = "request"
            sock.sendall(
                b"\x05\x01\x00\x01" + socket.inet_aton("127.0.0.1") + TARGET_PORT.to_bytes(2, "big")
            )
            head = recv_exact(sock, 4)
            if head[1] != 0:
                return f"request_rejected:{head[1]}"
            recv_exact(sock, {1: 4, 4: 16}.get(head[3], 0) + 2)
            stage = "response"
            sock.sendall(b"GET /probe HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            response = b""
            while len(response) < 65536:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            return "ok" if response.startswith(b"HTTP/1.0 200") and TARGET_BODY in response else "bad_response"
    except (ConnectionError, OSError) as error:
        return f"{stage}_closed:{type(error).__name__}"


def expect_denied(username, password, label):
    result = socks_fetch(username, password)
    check(result in DENIED, f"{label} (got {result})")


def expect_ok(username, password, label):
    result = socks_fetch(username, password)
    check(result == "ok", f"{label} (got {result})")


def run(command, data=None):
    subprocess.run(command, input=data, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def create_user(name, password):
    run(["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", name])
    # Through stdin, never argv.
    run(["chpasswd"], f"{name}:{password}\n".encode())


def install_key(content, mode=0o600, owner=0, symlink=False, fifo=False):
    KEY_DIR.mkdir(mode=0o700, exist_ok=True)
    for path in (KEY_FILE, KEY_DIR / "real.key"):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    if content is None:
        return
    target = KEY_DIR / "real.key" if symlink else KEY_FILE
    if fifo:
        os.mkfifo(target, 0o600)
        return
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, content)
    os.close(fd)
    os.chown(target, owner, owner)
    os.chmod(target, mode)
    if symlink:
        os.symlink(target, KEY_FILE)


def install_pam(region=None, legacy=None):
    """Installs the shipped template, replacing only the given placeholders."""
    template = (ROOT / "hackerai-egress.pam").read_text()
    if template.count("region=REGION") != 2 or template.count("legacy=LEGACY") != 2:
        raise SystemExit("PAM template changed: update this test")
    if region is not None:
        template = template.replace("region=REGION", f"region={region}")
    if legacy is not None:
        template = template.replace("legacy=LEGACY", f"legacy={legacy}")
    PAM_SERVICE.write_text(template)


def start_dante():
    DANTE_CONF.write_text(DANTE)
    log = open(DANTE_LOG, "wb")
    process = subprocess.Popen(["danted", "-f", str(DANTE_CONF)], stdout=log, stderr=log)
    deadline = time.time() + 15
    while time.time() < deadline:
        if process.poll() is not None:
            break
        try:
            socket.create_connection(("127.0.0.1", SOCKS_PORT), timeout=1).close()
            return process
        except OSError:
            time.sleep(0.2)
    print(DANTE_LOG.read_text(errors="replace")[-4000:])
    raise SystemExit("danted did not start")


def accepted(records):
    return [r["message"] for r in records if r["message"].startswith("hackerai-egress-v1 ")]


def event_for(vector):
    return (
        f"hackerai-egress-v1 accepted region=us owner={vector['owner']} "
        f"workspace={vector['workspace']}"
    )


def flip(value):
    return value[:-1] + ("0" if value[-1] != "0" else "1")


def main():
    if os.geteuid() != 0:
        raise SystemExit("run inside the isolated container as root")
    for package in ("dante-server", "libpam-modules", "libssl3t64"):
        version = subprocess.run(
            ["dpkg-query", "-W", "-f=${Version}", package], capture_output=True, text=True
        ).stdout.strip()
        print(f"{package} {version or 'unknown'}")

    syslog = SyslogCapture()
    target = http.server.ThreadingHTTPServer(("127.0.0.1", TARGET_PORT), Target)
    threading.Thread(target=target.serve_forever, daemon=True).start()
    create_user(LEGACY["username"], LEGACY["password"])
    # A local account in the reserved namespace must never authenticate.
    create_user(LOCAL_RESERVED["username"], LOCAL_RESERVED["password"])
    # Neither may any other host account.
    create_user(OTHER_LOCAL["username"], OTHER_LOCAL["password"])
    good_key = (FIXTURE["attributionKeys"]["us"] + "\n").encode()
    install_key(good_key)
    dante = start_dante()
    try:
        # An incompletely configured service fails every login, legacy included.
        hits = Target.hits
        for label, options in {
            "the uninstalled template": {},
            "a template without its legacy name": {"region": "us"},
            "a template without its region": {"legacy": LEGACY["username"]},
            "a reserved legacy name": {"region": "us", "legacy": LOCAL_RESERVED["username"]},
        }.items():
            install_pam(**options)
            mark = syslog.mark()
            expect_denied(US1["username"], US1["password"], f"{label} rejects attributed names")
            expect_denied(LEGACY["username"], LEGACY["password"], f"{label} rejects the legacy login")
            expect_denied(
                LOCAL_RESERVED["username"], LOCAL_RESERVED["password"], f"{label} rejects local accounts"
            )
            check(accepted(syslog.since(mark)) == [], f"{label} logs no event")
        check(Target.hits == hits, "no login reached the target while misconfigured")

        install_pam("us", LEGACY["username"])
        mark = syslog.mark()
        hits = Target.hits
        results = [socks_fetch(US1["username"], US1["password"]) for _ in range(3)]
        results += [socks_fetch(US2["username"], US2["password"]) for _ in range(2)]
        ok = all(result == "ok" for result in results)
        check(ok, f"attributed workspaces connect without any passwd entry (got {results})")
        if not ok:
            print("Attributed login failed while legacy may work: Dante may require a passwd entry; stop this design.")
        rejected = {
            "a forged password": (US1["username"], flip(US1["password"])),
            "another workspace's password": (US2["username"], US1["password"]),
            "the other region's credential": (EU1["username"], EU1["password"]),
            "an uppercase reference": (US1["username"][:7] + US1["username"][7:].upper(), US1["password"]),
            "an unknown version": ("hae-v2-" + US1["username"][7:], US1["password"]),
            "a truncated name": (US1["username"][:-1], US1["password"]),
            "the bare reserved prefix": ("hae-", US1["password"]),
            "an oversized password": (US1["username"], "a" * 255),
            "a local reserved-prefix account": (LOCAL_RESERVED["username"], LOCAL_RESERVED["password"]),
            "another local account": (OTHER_LOCAL["username"], OTHER_LOCAL["password"]),
            "the root account": ("root", OTHER_LOCAL["password"]),
            "a wrong legacy password": (LEGACY["username"], flip(LEGACY["password"])),
        }
        for label, (username, password) in rejected.items():
            expect_denied(username, password, f"rejects {label}")
        expect_ok(LEGACY["username"], LEGACY["password"], "legacy shared login still works")
        check(Target.hits - hits == 6, "only accepted logins reached the target")

        records = syslog.since(mark)
        events = accepted(records)
        check(
            sorted(events) == sorted([event_for(US1)] * 3 + [event_for(US2)] * 2),
            "exactly one fixed event per accepted attributed connection",
        )
        check(
            all(r["facility"] == 10 for r in records if r["message"] in events),
            "events use the AUTHPRIV facility",
        )
        raw = b"".join(r["raw"] for r in syslog.since(0, settle=0))
        check(not any(secret.encode() in raw for secret in SECRETS), "no secret appears in syslog")
        check(b"/probe" not in raw and b"loopback-target" not in raw, "no request data appears in syslog")

        verify_collector(records)

        bad_keys = {
            "a group-readable key": dict(content=good_key, mode=0o640),
            "a world-readable key": dict(content=good_key, mode=0o644),
            "a key owned by another user": dict(content=good_key, owner=NOBODY),
            "a symlinked key": dict(content=good_key, symlink=True),
            "a FIFO instead of a key": dict(content=b"", fifo=True),
            "an uppercase key": dict(content=good_key.upper()),
            "a key with extra content": dict(content=good_key + b"\n"),
            "the other region's key": dict(content=(FIXTURE["attributionKeys"]["eu"] + "\n").encode()),
            "a missing key": dict(content=None),
        }
        for label, options in bad_keys.items():
            install_key(**options)
            mark = syslog.mark()
            expect_denied(US1["username"], US1["password"], f"fails closed with {label}")
            expect_ok(LEGACY["username"], LEGACY["password"], f"legacy unaffected by {label}")
            check(accepted(syslog.since(mark)) == [], f"no event with {label}")

        # Recovery: the key is read per authentication, without a restart.
        install_key(good_key)
        mark = syslog.mark()
        expect_ok(US1["username"], US1["password"], "recovers when a valid key returns")
        check(accepted(syslog.since(mark)) == [event_for(US1)], "recovered login is counted once")
    finally:
        dante.terminate()
        try:
            dante.wait(timeout=10)
        except subprocess.TimeoutExpired:
            dante.kill()
        target.shutdown()

    if failures:
        print(DANTE_LOG.read_text(errors="replace")[-4000:])
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all egress attribution integration checks passed")
    return 0


def verify_collector(records):
    """Replays the captured authentication records to the collector as
    journal JSON and uploads the result to a verifying loopback sink."""
    lines = [
        (record["at"], json.dumps(
            {
                "__CURSOR": f"s=integration;i={index:x}",
                "__REALTIME_TIMESTAMP": str(int(record["at"] * 1_000_000)),
                "MESSAGE": record["message"],
                "SYSLOG_FACILITY": str(record["facility"]),
                "_SYSTEMD_UNIT": "danted.service",
            }
        ).encode())
        for index, record in enumerate(records, start=1)
    ]
    start = records[0]["at"] if records else time.time()
    with tempfile.TemporaryDirectory() as state:
        each = collector.Collector(os.path.join(state, "state.sqlite3"), "us", "danted.service", now=start - 120)
        # Each entry is read when it was logged, as journalctl would follow it.
        for logged_at, line in lines:
            each.process(line, now=logged_at)
        each.seal(now=time.time() + 180)
        sink = Sink([200] * 10)
        try:
            uploader = collector.Uploader(
                sink.url, "us", bytes.fromhex(FIXTURE["telemetryKeys"]["us"]), True
            )
            check(uploader.drain(each), "collector uploads every sealed minute")
        finally:
            sink.close()
            each.close()
    totals = {}
    for request in sink.received:
        for count in json.loads(request["body"])["counts"]:
            key = (count["owner"], count["workspace"])
            totals[key] = totals.get(key, 0) + count["connections"]
    check(all(request["valid"] for request in sink.received), "uploads carry valid regional signatures")
    check(
        all(json.loads(request["body"])["droppedEvents"] == 0 for request in sink.received),
        "no authentication event was reported lost",
    )
    check(
        totals == {(US1["owner"], US1["workspace"]): 3, (US2["owner"], US2["workspace"]): 2},
        "collector counts accepted connections per workspace",
    )


if __name__ == "__main__":
    sys.exit(main())
