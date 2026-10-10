"""Synthetic local fixture only. Never accepts customer VPN configurations."""

import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, **kwargs)


def write(path, value):
    path = Path(path)
    path.write_text(value)
    path.chmod(0o600)


def start_vpn():
    run("openvpn", "--config", "/secrets/client.ovpn", "--daemon",
        "--writepid", "/run/fixture-vpn.pid", "--log", "/run/fixture-vpn.log")


def bootstrap():
    root = Path("/secrets")
    for name in ("server", "gateway", "runner", "lab", "ca"):
        (root / name).mkdir(mode=0o700)
    os.chdir(root / "ca")
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=HackerAI-Disposable-Test-CA")
    for name, usage in (("server", "serverAuth"), ("gateway", "clientAuth")):
        target = root / name
        run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(target / "key.pem"),
            "-out", f"{name}.csr", "-subj", f"/CN=fixture-{name}")
        write("extensions", f"extendedKeyUsage={usage}\nkeyUsage=digitalSignature,keyEncipherment\n")
        run("openssl", "x509", "-req", "-in", f"{name}.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
            "-CAcreateserial", "-out", str(target / "cert.pem"), "-days", "1", "-extfile", "extensions")
        write(target / "ca.crt", Path("ca.crt").read_text())
    run("openvpn", "--genkey", "secret", str(root / "server" / "tls.key"))
    write(root / "gateway" / "tls.key", (root / "server" / "tls.key").read_text())
    password = secrets.token_urlsafe(32)
    write(root / "gateway" / "proxy-password", password)
    write(root / "runner" / "proxy-password", password)
    for folder, name in (("lab", "host_key"), ("runner", "id_ed25519")):
        run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / folder / name))
    write(root / "runner" / "known_hosts", "fixture-lab " + (root / "lab" / "host_key.pub").read_text())
    write(root / "lab" / "authorized_keys", (root / "runner" / "id_ed25519.pub").read_text())
    marker = secrets.token_hex(24)
    write(root / "lab" / "marker", marker)
    write(root / "runner" / "marker", marker)
    for p in root.rglob("*"):
        if p.is_file():
            p.chmod(0o600)
    (root / "lab").chmod(0o755)
    (root / "lab" / "authorized_keys").chmod(0o644)


def gateway(settings):
    run("chpasswd", input=("proxyuser:" + Path("/secrets/proxy-password").read_text() + "\n").encode())
    # A route change or VPN failure must not send lab traffic over another interface.
    run("iptables", "-A", "OUTPUT", "-d", settings["lab_subnet"], "!", "-o", "tun0", "-j", "REJECT")
    run("iptables", "-A", "OUTPUT", "-d", "169.254.0.0/16", "-j", "REJECT")
    config = f"""logoutput: /run/danted.log
internal: {settings['gateway_ip']} port = 1080
external: tun0
socksmethod: username
clientmethod: none
user.privileged: root
user.unprivileged: nobody
client pass {{
 from: {settings['runner_ip']}/32 to: 0.0.0.0/0
}}
"""
    for port in (22, 8080, 8081):
        config += f"""socks pass {{
 from: {settings['runner_ip']}/32 to: {settings['target_ip']}/32 port = {port}
 command: connect
 socksmethod: username
 user: proxyuser
}}
"""
    config += "socks block { from: 0.0.0.0/0 to: 0.0.0.0/0 }\n"
    write("/run/danted.conf", config)
    start_vpn()
    for _ in range(100):
        if Path("/run/fixture-vpn.log").exists() and "Initialization Sequence Completed" in Path("/run/fixture-vpn.log").read_text():
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("VPN initialization did not complete")
    run("danted", "-V", "-f", "/run/danted.conf")
    os.execvp("danted", ["danted", "-f", "/run/danted.conf"])


def server(settings):
    run("iptables", "-t", "nat", "-A", "POSTROUTING", "-s", "10.203.0.0/24",
        "-d", settings["lab_subnet"], "-j", "MASQUERADE")
    os.execvp("openvpn", ["openvpn", "--config", "/secrets/vpn.conf",
                          "--log", "/run/fixture-vpn.log"])


def lab():
    Path("/run/sshd").mkdir(exist_ok=True)
    # Unlock fixture account using a random password on protected stdin; password login stays disabled.
    run("chpasswd", input=("labuser:" + secrets.token_urlsafe(32) + "\n").encode())
    write("/run/sshd_config", """Port 22
HostKey /secrets/host_key
AuthorizedKeysFile /secrets/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
StrictModes no
AllowUsers labuser
""")
    subprocess.Popen(["/usr/sbin/sshd", "-D", "-f", "/run/sshd_config"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = Path("/secrets/marker").read_bytes()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    role = sys.argv[1]
    if role == "bootstrap":
        uid, gid = int(sys.argv[2]), int(sys.argv[3])
        try:
            bootstrap()
        finally:
            # Native Linux bind mounts retain container ownership. Hand generated
            # files back to the invoking host user, including on partial failure,
            # so protected credentials can be read and removed without sudo.
            for path in Path("/secrets").rglob("*"):
                os.chown(path, uid, gid)
    else:
        settings = json.loads(Path("/secrets/settings.json").read_text())
        if role == "gateway":
            gateway(settings)
        elif role == "server":
            server(settings)
        elif role == "lab":
            lab()
        elif role == "runner":
            while True:
                time.sleep(3600)
        elif role == "vpn-restart":
            start_vpn()
        else:
            raise ValueError("Unknown fixture role")
