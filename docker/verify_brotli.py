"""Reject sandbox builds with affected or unverified active Brotli decoders."""

import importlib
import importlib.util
from pathlib import Path
import re
import subprocess


MINIMUM_VERSION = "1.2.0-4.1"


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def require_fixed_package(package):
    status = command("dpkg-query", "-W", "-f=${db:Status-Status}", package)
    version = command("dpkg-query", "-W", "-f=${Version}", package)
    if status != "installed":
        raise RuntimeError(f"{package} is not fully installed")
    subprocess.run(
        ["dpkg", "--compare-versions", version, "ge", MINIMUM_VERSION],
        check=True,
        timeout=30,
    )
    print(f"{package}: {version}")


def require_owned_file(filename, package):
    path = str(Path(filename).resolve(strict=True))
    owners = command("dpkg-query", "-S", path).splitlines()
    for entry in owners:
        owner, separator, owned_path = entry.rpartition(": ")
        if separator and owned_path == path and owner.split(":", 1)[0] == package:
            return
    raise RuntimeError(f"Unverified {package} file: {path}")


def require_system_decoder(filename):
    dependencies = command("ldd", str(Path(filename).resolve(strict=True)))
    decoder = re.search(r"libbrotlidec\.so\.\S+\s+=>\s+(\S+)", dependencies)
    if decoder is None:
        raise RuntimeError(f"No system Brotli decoder linked by {filename}")
    for library in re.finditer(r"libbrotli\w+\.so\.\S+\s+=>\s+(\S+)", dependencies):
        require_owned_file(library[1], "libbrotli1")


def verify():
    packages = {"libbrotli1", "python3-brotli"}
    for package in sorted(packages):
        require_fixed_package(package)
    require_system_decoder("/usr/bin/curl")

    # The distro extension embeds Brotli. Checking only the shared library or
    # Python distribution metadata misses old wheels in /usr/local.
    brotli = importlib.import_module("brotli")
    extension = importlib.import_module("_brotli")
    require_owned_file(brotli.__file__, "python3-brotli")
    require_owned_file(extension.__file__, "python3-brotli")
    payload = b"sandbox Brotli decoder check"
    if brotli.decompress(brotli.compress(payload)) != payload:
        raise RuntimeError("Brotli round trip failed")

    # Some HTTP clients prefer cffi. Debian links it to the shared library;
    # independently bundled wheels require separate review before acceptance.
    if importlib.util.find_spec("brotlicffi") is not None:
        cffi = importlib.import_module("brotlicffi")
        cffi_extension = importlib.import_module("brotlicffi._brotlicffi")
        for module in (cffi, cffi_extension):
            require_owned_file(module.__file__, "python3-brotlicffi")
        require_system_decoder(cffi_extension.__file__)
        packages.add("python3-brotlicffi")
        if cffi.decompress(brotli.compress(payload)) != payload:
            raise RuntimeError("Brotli cffi decoding failed")

    # Ownership alone does not catch an installer overwriting a distro file.
    for package in sorted(packages):
        if command("dpkg", "--verify", package):
            raise RuntimeError(f"Modified decoder package: {package}")
    print("Active Brotli decoders verified")


if __name__ == "__main__":
    verify()
