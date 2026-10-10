#!/usr/bin/env python3
"""Run a real disposable OpenVPN lab using only the selected local Docker engine.

No customer configuration, E2B credentials, production services, host ports or
host VPN routes are used. This demonstrates gateway feasibility, NOT E2B behavior.
"""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time


SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parents[1]


class Docker:
    def __init__(self, context):
        self.prefix = ["docker", "--context", context]

    def call(self, *args, timeout=40):
        result = subprocess.run(self.prefix + list(args), capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            # Never echo arbitrary container output or config into the transcript.
            # Network commands contain only generated fixture names/addresses,
            # so their daemon diagnostics are safe and useful across Docker hosts.
            detail = f": {result.stderr.strip()[:2000]}" if args[0] == "network" else ""
            raise RuntimeError(f"Docker {args[0]} failed (exit {result.returncode}){detail}")
        return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True, help="Explicit local Docker context; never changes the default")
    parser.add_argument("--image", required=True, help="Locally built prototype image ID")
    parser.add_argument("--protocol", choices=("udp", "tcp"), default="udp", help="Synthetic OpenVPN profile transport")
    parser.add_argument("--output", type=Path, default=ROOT / ".artifacts/vpn-lab-prototype/result.json")
    args = parser.parse_args()
    docker = Docker(args.context)
    # Refuse a remote daemon: bind mounts and this fixture are intentionally local.
    context = json.loads(docker.call("context", "inspect", args.context))[0]
    if not context["Endpoints"]["docker"]["Host"].startswith("unix://"):
        raise RuntimeError("Only a local Unix-socket Docker context is allowed")
    args.image = json.loads(docker.call("image", "inspect", args.image))[0]["Id"]
    prefix = "hackerai-vpn-spike-" + secrets.token_hex(5)
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    containers = []
    networks = []
    result = {
        "scope": "local synthetic VPN fixture; not E2B or Production acceptance",
        "context": args.context, "image": args.image, "resource_prefix": prefix,
        "started_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checks": [], "cleanup": {},
        "comparison": {
            "profile_protocol": args.protocol,
            "baseline": "local runner without TUN, modeling lib/system-prompt.ts Cloud limitation",
            "proposed": "same profile on native-TUN VPN gateway; runner uses SOCKS",
            "actual_e2b_tested": False,
        },
    }
    start = time.monotonic()

    def network(role):
        name = f"{prefix}-{role}"
        # Declare IPAM explicitly for portable static container addresses.
        # Let Docker reject collisions with existing networks and retry only that
        # condition, without inspecting or changing unrelated network resources.
        for _ in range(10):
            subnet = f"10.{240 + secrets.randbelow(15)}.{secrets.randbelow(256)}.0/24"
            try:
                docker.call("network", "create", "--internal", "--subnet", subnet,
                            "--label", f"hackerai.vpn-spike={prefix}", name)
                break
            except RuntimeError as error:
                if "Pool overlaps" not in str(error):
                    raise
        else:
            raise RuntimeError("Could not allocate a non-overlapping fixture network")
        networks.append(name)
        data = json.loads(docker.call("network", "inspect", name))[0]
        subnet = data["IPAM"]["Config"][0]["Subnet"]
        if ipaddress.ip_network(subnet).overlaps(ipaddress.ip_network("10.203.0.0/24")):
            raise RuntimeError("Fixture network overlaps the VPN subnet")
        return name, subnet

    def create(role, network_name, secret_dir, address, extra=()):
        name = f"{prefix}-{role}"
        docker.call("create", "--name", name, "--label", f"hackerai.vpn-spike={prefix}",
                    "--network", network_name, "--ip", address, "--memory", "256m", "--cpus", "0.5",
                    "--mount", f"type=bind,src={secret_dir},dst=/secrets,readonly",
                    *extra, args.image, role if role != "other" else "lab")
        containers.append(name)
        return name

    def check(name, runner, operation, expected=True):
        try:
            raw = docker.call("exec", runner, "python3", "/fixture/verify.py", operation)
            data = json.loads(raw)
            passed = data["passed"] == expected
        except (RuntimeError, subprocess.TimeoutExpired):
            passed = False
        result["checks"].append({"name": name, "passed": passed})
        print(f"{'PASS' if passed else 'FAIL'} {name}", flush=True)
        if not passed:
            raise RuntimeError(f"Probe failed: {name}")

    def wait_for_http(runner):
        for _ in range(30):
            try:
                raw = docker.call("exec", runner, "python3", "/fixture/verify.py", "http", timeout=8)
                if json.loads(raw)["passed"]:
                    return True
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            time.sleep(0.5)
        return False

    # Temporary key material remains local, mode 0700, and is deleted after teardown.
    with tempfile.TemporaryDirectory(prefix="vpn-fixture-", dir=args.output.parent) as tmp:
        root = Path(tmp)
        try:
            # The bootstrap container has no network; only synthetic credentials are generated.
            bootstrap_name = prefix + "-bootstrap"
            containers.append(bootstrap_name)
            docker.call("run", "--name", bootstrap_name, "--network", "none",
                        "--label", f"hackerai.vpn-spike={prefix}",
                        "--mount", f"type=bind,src={root},dst=/secrets", args.image, "bootstrap",
                        str(os.getuid()), str(os.getgid()), timeout=90)
            wan, wan_subnet = network("transport")
            labnet, lab_subnet = network("private-lab")
            runnernet, runner_subnet = network("runner")
            def address(subnet, offset):
                return str(ipaddress.ip_network(subnet).network_address + offset)

            settings = {
                "lab_subnet": lab_subnet,
                "target_ip": address(lab_subnet, 10),
                "other_ip": address(lab_subnet, 11),
                "server_ip": address(wan_subnet, 10),
                "gateway_ip": address(runner_subnet, 10),
                "runner_ip": address(runner_subnet, 11),
            }
            caps = ("--cap-add", "NET_ADMIN", "--device", "/dev/net/tun",
                    "--sysctl", "net.ipv4.ip_forward=1")
            # Declare static addresses before startup. Disconnecting a never-started
            # container is unsupported on some Docker engines.
            target = create("lab", labnet, root / "lab", settings["target_ip"])
            other = create("other", labnet, root / "lab", settings["other_ip"])
            server = create("server", wan, root / "server", settings["server_ip"], caps)
            gateway = create("gateway", wan, root / "gateway", address(wan_subnet, 12), caps)
            runner = create("runner", runnernet, root / "runner", settings["runner_ip"])
            docker.call("network", "connect", "--ip", address(lab_subnet, 12), labnet, server)
            docker.call("network", "connect", "--ip", settings["gateway_ip"], runnernet, gateway)
            # Both paths can reach the VPN endpoint. The baseline must fail on
            # its missing TUN device, not an unreachable server or invalid profile.
            docker.call("network", "connect", "--ip", address(wan_subnet, 11), wan, runner)
            for directory in ("server", "gateway", "runner", "lab"):
                (root / directory / "settings.json").write_text(json.dumps(settings))
            common = """dev tun0
topology subnet
ca /secrets/ca.crt
cert /secrets/cert.pem
key /secrets/key.pem
tls-crypt /secrets/tls.key
data-ciphers AES-256-GCM
auth SHA256
verb 3
"""
            (root / "server" / "vpn.conf").write_text(common + f"""proto {'tcp-server' if args.protocol == 'tcp' else 'udp'}
port 1194
server 10.203.0.0 255.255.255.0
dh none
keepalive 2 10
remote-cert-tls client
push "route {ipaddress.ip_network(lab_subnet).network_address} {ipaddress.ip_network(lab_subnet).netmask}"
""")
            profile = f"""client
dev tun0
topology subnet
data-ciphers AES-256-GCM
auth SHA256
verb 3
proto {'tcp-client' if args.protocol == 'tcp' else 'udp'}
remote {settings['server_ip']} 1194
nobind
remote-cert-tls server
verify-x509-name fixture-server name
connect-retry-max 1
resolv-retry 1
"""
            for tag, filename in (("ca", "ca.crt"), ("cert", "cert.pem"), ("key", "key.pem"), ("tls-crypt", "tls.key")):
                profile += f"<{tag}>\n" + (root / "gateway" / filename).read_text().strip() + f"\n</{tag}>\n"
            for directory in ("gateway", "runner"):
                path = root / directory / "client.ovpn"
                path.write_text(profile)
                path.chmod(0o600)
            (root / "server" / "vpn.conf").chmod(0o600)
            # Export only fingerprints, never profile bytes or embedded private keys.
            digests = {role: hashlib.sha256((root / role / "client.ovpn").read_bytes()).hexdigest()
                       for role in ("gateway", "runner")}
            result["comparison"]["profile_sha256"] = digests
            if len(set(digests.values())) != 1:
                raise RuntimeError("Comparison profiles differ")
            for container in (target, other, server, runner):
                docker.call("start", container)
            # Readiness is checked on the server so a transient startup failure
            # cannot masquerade as the baseline's expected TUN failure.
            for _ in range(50):
                ready = docker.call("exec", server, "python3", "-c",
                    "from pathlib import Path; p=Path('/run/fixture-vpn.log'); print(p.exists() and 'Initialization Sequence Completed' in p.read_text())")
                if ready == "True":
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError("VPN server readiness failed")
            check("baseline same .ovpn fails specifically on missing TUN", runner, "native-vpn-unavailable")
            check("baseline cannot fetch private HTTP response", runner, "direct-http-denied")
            check("baseline cannot log in to private SSH", runner, "direct-ssh-denied")
            docker.call("start", gateway)
            if not wait_for_http(runner):
                # Save only non-secret stage labels, never raw OpenVPN/config logs.
                for container in (target, server, gateway):
                    state = json.loads(docker.call("inspect", container))[0]["State"]
                    result["checks"].append({"name": container.rsplit("-", 1)[-1] + " running", "passed": state["Running"]})
                    # These are generated fixture logs, not customer logs. Emit only
                    # matching fixed diagnostic labels, never their original content.
                    raw_logs = docker.call("logs", container)
                    for label in ("CalledProcessError", "VPN initialization did not complete", "PermissionError"):
                        if label in raw_logs:
                            result.setdefault("diagnostic_labels", []).append(label)
                raise RuntimeError("VPN HTTP readiness failed; inspect fixture code before retrying")
            for name, operation in (
                ("runner has no direct private-lab route", "direct-denied"),
                ("exact private HTTP response through VPN", "http"),
                ("verified SSH login through VPN", "ssh"),
                ("wrong session credential rejected", "wrong-password-denied"),
                ("closed TCP service rejected locally", "closed-port-denied"),
                ("unapproved port rejected", "unapproved-port-denied"),
                ("other private host rejected", "unapproved-host-denied"),
                ("metadata destination rejected", "metadata-denied"),
            ):
                check(name, runner, operation)
            docker.call("exec", gateway, "python3", "-c",
                        "import os,signal; from pathlib import Path; os.kill(int(Path('/run/fixture-vpn.pid').read_text()),signal.SIGTERM)")
            time.sleep(1)
            check("VPN down blocks private access", runner, "vpn-down-denied")
            # An alternate route must not bypass the VPN-only interface rule.
            docker.call("exec", gateway, "ip", "route", "replace", lab_subnet, "via", settings["server_ip"])
            check("alternate non-VPN route remains blocked", runner, "vpn-down-denied")
            docker.call("exec", gateway, "ip", "route", "del", lab_subnet)
            docker.call("exec", gateway, "python3", "/fixture/fixture.py", "vpn-restart")
            if not wait_for_http(runner):
                raise RuntimeError("VPN reconnect readiness failed")
            check("HTTP recovers after VPN reconnect", runner, "http")
            check("SSH recovers after VPN reconnect", runner, "ssh")
            result["passed"] = True
        except Exception as error:
            result["passed"] = False
            result["error"] = str(error)
            print("FAIL " + str(error), flush=True)
        finally:
            failed_cleanup = []
            for container in reversed(containers):
                try:
                    docker.call("rm", "-f", container)
                except Exception:
                    failed_cleanup.append(container)
            for net in reversed(networks):
                try:
                    docker.call("network", "rm", net)
                except Exception:
                    failed_cleanup.append(net)
            result["cleanup"]["remaining_resources"] = failed_cleanup
            result["elapsed_seconds"] = round(time.monotonic() - start, 2)
    result["cleanup"]["temporary_credentials_removed"] = not root.exists()
    result["passed"] = result.get("passed", False) and not result["cleanup"]["remaining_resources"]
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print("Evidence: " + str(args.output), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
