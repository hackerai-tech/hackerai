"""Application-level probes. SOCKS code is test instrumentation, not product code."""

import ipaddress
import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys


SETTINGS = json.loads(Path("/secrets/settings.json").read_text())


def receive(sock, count):
    result = b""
    while len(result) < count:
        data = sock.recv(count - len(result))
        if not data:
            raise ConnectionError("Truncated SOCKS reply")
        result += data
    return result


def connect(target, port, password=None):
    sock = socket.create_connection((SETTINGS["gateway_ip"], 1080), timeout=3)
    try:
        sock.sendall(b"\x05\x01\x02")
        if receive(sock, 2) != b"\x05\x02":
            raise ConnectionError("SOCKS authentication unavailable")
        username = b"proxyuser"
        password = (password if password is not None else Path("/secrets/proxy-password").read_text()).encode()
        sock.sendall(b"\x01" + bytes([len(username)]) + username + bytes([len(password)]) + password)
        if receive(sock, 2) != b"\x01\x00":
            raise ConnectionError("SOCKS authentication rejected")
        sock.sendall(b"\x05\x01\x00\x01" + ipaddress.ip_address(target).packed + struct.pack("!H", port))
        header = receive(sock, 4)
        if header[:3] != b"\x05\x00\x00":
            raise ConnectionError("SOCKS destination rejected")
        if header[3] == 1:
            receive(sock, 6)
        elif header[3] == 4:
            receive(sock, 18)
        elif header[3] == 3:
            receive(sock, receive(sock, 1)[0] + 2)
        else:
            raise ConnectionError("Invalid SOCKS address type")
        return sock
    except BaseException:
        sock.close()
        raise


def http(target=None, direct=False):
    target = target or SETTINGS["target_ip"]
    connection = socket.create_connection((target, 8080), timeout=2) if direct else connect(target, 8080)
    with connection as sock:
        sock.sendall(b"GET / HTTP/1.0\r\nHost: fixture-lab\r\n\r\n")
        response = b""
        while True:
            data = sock.recv(4096)
            if not data:
                break
            response += data
            if len(response) > 16384:
                raise RuntimeError("Oversized fixture response")
    return response.split(b"\r\n\r\n", 1)[1] == Path("/secrets/marker").read_bytes()


def ssh(direct=False):
    command = [
        "ssh", "-F", "/dev/null", "-i", "/secrets/id_ed25519",
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=/secrets/known_hosts", "-o", "HostKeyAlias=fixture-lab",
    ]
    if not direct:
        command += ["-o", "ProxyCommand=python3 /fixture/verify.py relay"]
    result = subprocess.run(command + [
        "labuser@" + SETTINGS["target_ip"], "printf vpn-ssh-ok",
    ], capture_output=True, timeout=10)
    return result.returncode == 0 and result.stdout == b"vpn-ssh-ok"


def native_vpn_unavailable():
    """Exercise the same file without TUN. This models the documented Cloud limitation,
    not a measurement of an actual E2B sandbox. Only accept the specific device error.
    """
    log = Path("/run/baseline-vpn.log")
    try:
        result = subprocess.run([
            "openvpn", "--config", "/secrets/client.ovpn", "--log", str(log),
        ], capture_output=True, timeout=20)
        return result.returncode != 0 and log.exists() and "Cannot open TUN/TAP dev" in log.read_text()
    except subprocess.TimeoutExpired:
        return False
    finally:
        log.unlink(missing_ok=True)


def relay():
    with connect(SETTINGS["target_ip"], 22) as sock:
        sock.settimeout(None)
        readers = [sock, sys.stdin.buffer]
        while readers:
            ready, _, _ = select.select(readers, [], [])
            for source in ready:
                if source is sock:
                    data = sock.recv(65536)
                    if not data:
                        return
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        sock.shutdown(socket.SHUT_WR)
                        readers.remove(source)
                    else:
                        sock.sendall(data)


def denied(function):
    try:
        result = function()
        if isinstance(result, socket.socket):
            result.close()
        return False
    except (OSError, ConnectionError):
        return True


if __name__ == "__main__":
    operation = sys.argv[1]
    if operation == "relay":
        try:
            relay()
        except (OSError, ConnectionError):
            sys.exit(1)
        sys.exit(0)
    probes = {
        "http": http,
        "ssh": ssh,
        "native-vpn-unavailable": native_vpn_unavailable,
        "direct-http-denied": lambda: denied(lambda: http(direct=True)),
        "direct-ssh-denied": lambda: not ssh(direct=True),
        "direct-denied": lambda: denied(lambda: socket.create_connection((SETTINGS["target_ip"], 8080), timeout=2)),
        "wrong-password-denied": lambda: denied(lambda: connect(SETTINGS["target_ip"], 8080, "invalid-fixture-password")),
        "closed-port-denied": lambda: denied(lambda: connect(SETTINGS["target_ip"], 8081)),
        "unapproved-port-denied": lambda: denied(lambda: connect(SETTINGS["target_ip"], 80)),
        "unapproved-host-denied": lambda: denied(lambda: connect(SETTINGS["other_ip"], 8080)),
        "metadata-denied": lambda: denied(lambda: connect("169.254.169.254", 80)),
        "vpn-down-denied": lambda: denied(http),
    }
    try:
        passed = bool(probes[operation]())
    except Exception:
        passed = False
    print(json.dumps({"probe": operation, "passed": passed}))
    sys.exit(0 if passed else 1)
