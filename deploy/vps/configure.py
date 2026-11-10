#!/usr/bin/env python3
"""Create private configuration on the VPS; secrets never enter command arguments."""
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

os.umask(0o077)
directory = Path(__file__).resolve().parent
os.chdir(directory)
domain = os.environ.get("DOMAIN", "tandi.tech")
if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", domain):
    raise SystemExit("Domínio inválido.")
configuration = directory / ".env"
if configuration.exists():
    raise SystemExit("Configuração existente preservada. Para alterar a senha, use change-password.py.")
email = input("E-mail da conta administradora: ").strip().lower()
if not re.fullmatch(r"[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", email):
    raise SystemExit("E-mail inválido.")
password = getpass.getpass("Senha local (mínimo 14 caracteres): ")
if len(password) < 14 or len(password) > 1024:
    raise SystemExit("Use entre 14 e 1024 caracteres.")
if password != getpass.getpass("Confirme a senha: "):
    raise SystemExit("As senhas não coincidem.")
salt = secrets.token_hex(16)
digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()
auth = directory / "private/auth"
auth.mkdir(parents=True, exist_ok=True)
subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(auth / "private.pem")], check=True, stderr=subprocess.DEVNULL)
subprocess.run(["openssl", "pkey", "-in", str(auth / "private.pem"), "-pubout", "-out", str(auth / "public.pem")], check=True)
values = {
    "DOMAIN": domain, "NEXT_PUBLIC_SELF_HOSTED": "true", "NEXT_PUBLIC_BASE_URL": f"https://{domain}",
    "NEXT_PUBLIC_CONVEX_URL": f"https://{domain}/convex", "SELF_HOSTED_AUTH_ISSUER": f"https://{domain}",
    "LOCAL_AUTH_EMAIL": email, "LOCAL_AUTH_USER_ID": "user_vps_admin", "LOCAL_AUTH_PASSWORD_HASH": f"{salt}:{digest}",
    "CONVEX_SERVICE_ROLE_KEY": secrets.token_hex(32), "CONVEX_USER_RESEARCH_SERVICE_KEY": secrets.token_hex(32),
    "ACCOUNT_IDENTITY_HMAC_SECRET": secrets.token_hex(32), "CENTRIFUGO_TOKEN_SECRET": secrets.token_hex(32),
    "CENTRIFUGO_WS_URL": f"wss://{domain}/connection/websocket", "OLLAMA_MODEL": "qwen2.5:3b",
    "LOCAL_CONTEXT_BUDGET": "8192", "AWS_S3_REGION": "us-east-1", "AWS_S3_BUCKET_NAME": "hackerai",
    "AWS_S3_ACCESS_KEY_ID": "hackerai" + secrets.token_hex(6), "AWS_S3_SECRET_ACCESS_KEY": secrets.token_hex(32),
    "S3_ENDPOINT_URL": f"https://{domain}", "S3_REGIONAL_STORAGE_ENABLED": "false",
}
configuration.write_text("".join(f"{name}={value}\n" for name, value in values.items()))
config = json.loads((directory / "centrifugo.json").read_text())
config["allowed_origins"] = [f"https://{domain}"]
(directory / "centrifugo.json").write_text(json.dumps(config, indent=2) + "\n")
if os.geteuid() == 0:
    os.chown(auth, 1000, 1000)
    for path in auth.iterdir():
        os.chown(path, 1000, 1000)
        path.chmod(0o400)
print("Configuração privada criada. A senha não foi gravada em texto puro.")
