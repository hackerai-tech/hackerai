#!/usr/bin/env python3
"""Exercise real Tauri bundles and signed N -> N+1 installs on disposable CI hosts.

The executable is an account-free probe using this checkout's pinned updater.
This checks packaging/installation, not the authenticated Desktop Agent journey.
Never run on a workstation with a package named hackerai-updater-fixture installed.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "packages/desktop"
TARGET = DESKTOP / "src-tauri/target/debug"
NAME = "hackerai-updater-fixture"


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, timeout=1800, **kwargs)


def main():
    if os.environ.get("CI") != "true" or os.uname().sysname != "Linux":
        raise SystemExit("Run only on a disposable Linux CI runner")
    if subprocess.run(["dpkg-query", "-W", NAME], capture_output=True).returncode == 0:
        raise SystemExit("Refusing to overwrite an existing fixture installation")
    with tempfile.TemporaryDirectory(prefix="desktop-package-upgrade-") as directory:
        work = Path(directory)
        feed = work / "feed"
        feed.mkdir()
        key = work / "signing.key"
        # Test key stays in the private temporary directory and is never logged.
        run(["pnpm", "tauri", "signer", "generate", "--ci", "-w", str(key)],
            cwd=DESKTOP, stdout=subprocess.DEVNULL)
        env = {**os.environ, "TAURI_SIGNING_PRIVATE_KEY_PATH": str(key),
               "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "", "APPIMAGE_EXTRACT_AND_RUN": "1"}
        config = work / "tauri.json"
        assets = {}
        for version in ["1.0.0", "1.0.1"]:
            config.write_text(json.dumps({
                "productName": NAME, "mainBinaryName": NAME, "version": version,
                "identifier": "co.hackerai.updaterfixture",
                "build": {"beforeBuildCommand": "", "beforeBundleCommand": ""},
                "bundle": {"createUpdaterArtifacts": False, "targets": ["deb", "appimage"],
                           "linux": {"deb": {"postInstallScript": None, "desktopTemplate": None}}},
            }))
            run(["cargo", "build", "--locked", "--example", "packaged_updater_probe"],
                cwd=DESKTOP / "src-tauri",
                env={**env, "HACKERAI_UPGRADE_FIXTURE_VERSION": version})
            shutil.copy2(TARGET / "examples/packaged_updater_probe", TARGET / NAME)
            run(["pnpm", "tauri", "bundle", "--debug", "--config", str(config),
                 "--bundles", "deb,appimage"], cwd=DESKTOP, env=env)
            for kind, suffix in [("deb", ".deb"), ("appimage", ".AppImage")]:
                matches = list((TARGET / "bundle" / kind).glob(f"*_{version}_*{suffix}"))
                if len(matches) != 1:
                    raise RuntimeError(f"Expected one {version} {kind} bundle, got {len(matches)}")
                destination = feed / matches[0].name
                shutil.copy2(matches[0], destination)
                assets[version, kind] = destination
                run(["pnpm", "tauri", "signer", "sign", str(destination)], cwd=DESKTOP,
                    env=env, stdout=subprocess.DEVNULL)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
            functools.partial(Handler, directory=str(feed)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        arch = "aarch64" if os.uname().machine == "aarch64" else "x86_64"
        platforms = {}
        for kind in ["deb", "appimage"]:
            asset = assets["1.0.1", kind]
            platforms[f"linux-{arch}-{kind}"] = {
                "url": origin + "/" + asset.name,
                "signature": Path(str(asset) + ".sig").read_text().strip()}
        # Legacy fallback is deliberately an AppImage; a .deb must prefer -deb.
        platforms[f"linux-{arch}"] = platforms[f"linux-{arch}-appimage"]
        (feed / "latest.json").write_text(json.dumps({"version": "1.0.1", "platforms": platforms}))
        sentinel = work / "existing-user-file.txt"
        sentinel.write_bytes(b"preserve existing user bytes\x00\n")
        try:
            run(["sudo", "dpkg", "-i", str(assets["1.0.0", "deb"])])
            installed = "/usr/bin/" + NAME
            assert run([installed], capture_output=True).stdout.strip() == "1.0.0"
            run([installed, origin + "/latest.json", str(key) + ".pub", ".deb"], env=env)
            assert run([installed], capture_output=True).stdout.strip() == "1.0.1"
            image = work / "installed.AppImage"
            shutil.copy2(assets["1.0.0", "appimage"], image)
            assert run([str(image)], capture_output=True, env=env).stdout.strip() == "1.0.0"
            run([str(image), origin + "/latest.json", str(key) + ".pub", ".AppImage"], env=env)
            assert run([str(image)], capture_output=True, env=env).stdout.strip() == "1.0.1"
            assert sentinel.read_bytes() == b"preserve existing user bytes\x00\n"
            print("PASS: Debian and AppImage select, verify, install and relaunch N+1; sentinel unchanged")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            run(["sudo", "dpkg", "--remove", NAME])


if __name__ == "__main__":
    main()
