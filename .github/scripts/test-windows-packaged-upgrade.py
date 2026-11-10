#!/usr/bin/env python3
"""Disposable CI: signed ZIP rejection/retry and actual NSIS N-to-N+1 handoff."""
import functools
import ctypes
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
        # Bundling v1-compatible updater ZIPs needs the key's contents; the
        # signer command below accepts the path. Keep the value in child env.
        bundle_env = {**env, "TAURI_SIGNING_PRIVATE_KEY": key.read_text().strip()}
        config = work / "tauri.json"
        assets = {}
        for version in ["1.0.0", "1.0.1"]:
            config.write_text(json.dumps({
                "productName": NAME, "mainBinaryName": NAME, "version": version,
                "identifier": "co.hackerai.windowsupdaterfixture",
                "build": {"beforeBuildCommand": "", "beforeBundleCommand": ""},
                "bundle": {"createUpdaterArtifacts": "v1Compatible", "targets": ["nsis"],
                           "windows": {"nsis": {"installMode": "currentUser"}}},
            }))
            run(["cargo", "build", "--locked", "--example", "windows_update_probe"],
                cwd=DESKTOP / "src-tauri",
                env={**env, "HACKERAI_UPGRADE_FIXTURE_VERSION": version})
            shutil.copy2(TARGET / "examples/windows_update_probe.exe", TARGET / (NAME + ".exe"))
            run([pnpm, "tauri", "bundle", "--debug", "--config", str(config),
                 "--bundles", "nsis"], cwd=DESKTOP, env=bundle_env)
            matches = list((TARGET / "bundle/nsis").glob(f"*_{version}_*-setup.exe"))
            if len(matches) != 1:
                raise RuntimeError(f"Expected one {version} NSIS bundle, got {len(matches)}")
            destination = feed / matches[0].name
            shutil.copy2(matches[0], destination)
            assets[version] = destination
            archives = list((TARGET / "bundle/nsis").glob(f"*_{version}_*-setup.nsis.zip"))
            if len(archives) != 1:
                raise RuntimeError(f"Expected one {version} updater ZIP, got {len(archives)}")
            archive = feed / archives[0].name
            shutil.copy2(archives[0], archive)
            shutil.copy2(Path(str(archives[0]) + ".sig"), Path(str(archive) + ".sig"))
            assets[version + "-zip"] = archive
        # Correctly signed, bounded input that reaches the ZIP parser but has no
        # central directory. Signature rejection alone would miss this boundary.
        malformed = feed / "malformed.nsis.zip"
        malformed.write_bytes(b"PK\x03\x04" + b"\x00" * 26)
        run([pnpm, "tauri", "signer", "sign", str(malformed)], cwd=DESKTOP,
            env=env, stdout=subprocess.DEVNULL)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
            functools.partial(Handler, directory=str(feed)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        def select_asset(asset):
            (feed / "latest.json").write_text(json.dumps({"version": "1.0.1", "url": origin + "/" + asset.name,
                "signature": Path(str(asset) + ".sig").read_text().strip()}))
        select_asset(malformed)
        sentinel = state / "user-file.txt"
        sentinel.write_bytes(b"preserve user bytes\x00\n")
        executable = installed / (NAME + ".exe")
        report = state / "result.json"
        # Keep a handle to the exact child, so cleanup never trusts a recycled PID.
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.WaitForSingleObject.restype = ctypes.c_ulong
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        job_handle = None
        try:
            run([str(assets["1.0.0"]), "/S", "/D=" + str(installed)])
            assert run([str(executable)], capture_output=True).stdout.strip() == "1.0.0"
            arguments = [origin + "/latest.json", str(key) + ".pub", str(state)]
            run([str(executable), "reject", *arguments])
            assert json.loads(report.read_text()) == {"version": "1.0.0", "outcome": "Rejected"}
            report.unlink()
            # A fresh process consumes the failed-install receipt without
            # reporting an upgrade or preventing a subsequent valid attempt.
            run([str(executable), "decline", *arguments])
            assert json.loads(report.read_text()) == {"version": "1.0.0", "outcome": "NotApplied"}
            assert run([str(executable)], capture_output=True).stdout.strip() == "1.0.0"
            assert sentinel.read_bytes() == b"preserve user bytes\x00\n"
            assert not (state / "pending-desktop-update.json").exists()
            report.unlink()
            select_asset(assets["1.0.1-zip"])
            run([str(executable), "decline", *arguments])
            assert json.loads(report.read_text()) == {"version": "1.0.0", "outcome": "Declined"}
            report.unlink()
            run([str(executable), "install", *arguments])
            job_handle = kernel.OpenProcess(0x00100000, False, int((state / "job-pid").read_text()))
            assert job_handle, "Detached job must survive updater handoff"
            deadline = time.monotonic() + 120
            while not report.exists() and time.monotonic() < deadline:
                time.sleep(0.25)
            assert report.exists(), "NSIS must automatically relaunch the upgraded executable"
            assert json.loads(report.read_text()) == {"version": "1.0.1", "outcome": "Applied"}
            assert run([str(executable)], capture_output=True).stdout.strip() == "1.0.1"
            assert not (state / "pending-desktop-update.json").exists()
            assert sentinel.read_bytes() == b"preserve user bytes\x00\n"
            assert kernel.WaitForSingleObject(job_handle, 0) == 258, "Detached job exited during upgrade"
            output = state / "job-output.txt"
            before = (state / "job-before-update.txt").read_bytes()
            at_restart = output.read_bytes()
            deadline = time.monotonic() + 10
            while output.stat().st_size <= len(at_restart) and time.monotonic() < deadline:
                time.sleep(0.05)
            after = output.read_bytes()
            assert after.startswith(before) and after.startswith(at_restart)
            assert len(after) > len(at_restart), "Detached job must keep writing after restart"
            complete_lines = after.split(b"\n")[:-1]
            assert [int(line) for line in complete_lines] == list(range(len(complete_lines)))
            print("PASS: signed malformed ZIP rejected; restart reports NotApplied; valid signed ZIP retry succeeds; declined install preserves N; approved NSIS install relaunches N+1; receipt consumed; sentinel unchanged; detached job keeps writing intact output")
        finally:
            (state / "stop-job").touch()
            if not job_handle and (state / "job-pid").exists():
                job_handle = kernel.OpenProcess(0x00100000, False, int((state / "job-pid").read_text()))
            job_stopped = True
            if job_handle:
                try:
                    job_stopped = kernel.WaitForSingleObject(job_handle, 10000) == 0
                finally:
                    kernel.CloseHandle(job_handle)
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            uninstaller = installed / "uninstall.exe"
            if uninstaller.exists():
                run([str(uninstaller), "/S"])
            assert job_stopped, "Test job did not stop"


if __name__ == "__main__":
    main()
