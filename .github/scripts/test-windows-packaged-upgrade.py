#!/usr/bin/env python3
"""Disposable CI: actual NSIS N-to-N+1 handoff, auto-relaunch and receipt readback."""
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "packages/desktop"
TARGET = DESKTOP / "src-tauri/target/debug"
NAME = "hackerai-windows-updater-fixture"


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, timeout=1800, **kwargs)


def main():
    if os.name != "nt" or os.environ.get("CI") != "true":
        raise SystemExit("Run only on a disposable Windows CI runner")
    pnpm = shutil.which("pnpm.cmd")
    if not pnpm:
        raise SystemExit("pnpm is required")
    with tempfile.TemporaryDirectory(prefix="desktop-windows-upgrade-") as directory:
        work = Path(directory)
        feed, state, installed = work / "feed", work / "state", work / "installed"
        feed.mkdir()
        state.mkdir()
        key = work / "signing.key"
        run([pnpm, "tauri", "signer", "generate", "--ci", "-w", str(key)],
            cwd=DESKTOP, stdout=subprocess.DEVNULL)
        env = {**os.environ, "TAURI_SIGNING_PRIVATE_KEY_PATH": str(key),
               "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": ""}
        config = work / "tauri.json"
        assets = {}
        for version in ["1.0.0", "1.0.1"]:
            config.write_text(json.dumps({
                "productName": NAME, "mainBinaryName": NAME, "version": version,
                "identifier": "co.hackerai.windowsupdaterfixture",
                "build": {"beforeBuildCommand": "", "beforeBundleCommand": ""},
                "bundle": {"createUpdaterArtifacts": False, "targets": ["nsis"],
                           "windows": {"nsis": {"installMode": "currentUser"}}},
            }))
            run(["cargo", "build", "--locked", "--example", "windows_update_probe"],
                cwd=DESKTOP / "src-tauri",
                env={**env, "HACKERAI_UPGRADE_FIXTURE_VERSION": version})
            shutil.copy2(TARGET / "examples/windows_update_probe.exe", TARGET / (NAME + ".exe"))
            run([pnpm, "tauri", "bundle", "--debug", "--config", str(config),
                 "--bundles", "nsis"], cwd=DESKTOP, env=env)
            matches = list((TARGET / "bundle/nsis").glob(f"*_{version}_*-setup.exe"))
            if len(matches) != 1:
                raise RuntimeError(f"Expected one {version} NSIS bundle, got {len(matches)}")
            destination = feed / matches[0].name
            shutil.copy2(matches[0], destination)
            assets[version] = destination
            run([pnpm, "tauri", "signer", "sign", str(destination)], cwd=DESKTOP,
                env=env, stdout=subprocess.DEVNULL)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
            functools.partial(Handler, directory=str(feed)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        asset = assets["1.0.1"]
        (feed / "latest.json").write_text(json.dumps({"version": "1.0.1", "url": origin + "/" + asset.name,
            "signature": Path(str(asset) + ".sig").read_text().strip()}))
        sentinel = state / "user-file.txt"
        sentinel.write_bytes(b"preserve user bytes\x00\n")
        executable = installed / (NAME + ".exe")
        report = state / "result.json"
        try:
            run([str(assets["1.0.0"]), "/S", "/D=" + str(installed)])
            assert run([str(executable)], capture_output=True).stdout.strip() == "1.0.0"
            arguments = [origin + "/latest.json", str(key) + ".pub", str(state)]
            run([str(executable), "decline", *arguments])
            assert json.loads(report.read_text()) == {"version": "1.0.0", "outcome": "Declined"}
            report.unlink()
            run([str(executable), "install", *arguments])
            deadline = time.monotonic() + 120
            while not report.exists() and time.monotonic() < deadline:
                time.sleep(0.25)
            assert report.exists(), "NSIS must automatically relaunch the upgraded executable"
            assert json.loads(report.read_text()) == {"version": "1.0.1", "outcome": "Applied"}
            assert run([str(executable)], capture_output=True).stdout.strip() == "1.0.1"
            assert not (state / "pending-desktop-update.json").exists()
            assert sentinel.read_bytes() == b"preserve user bytes\x00\n"
            print("PASS: declined install preserves N; approved NSIS install relaunches N+1; receipt consumed and files unchanged")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            uninstaller = installed / "uninstall.exe"
            if uninstaller.exists():
                run([str(uninstaller), "/S"])


if __name__ == "__main__":
    main()
