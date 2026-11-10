#!/usr/bin/env python3
import getpass
import hashlib
import os
from pathlib import Path
import secrets
os.umask(0o077)
path = Path(__file__).resolve().parent / '.env'
password = getpass.getpass('Nova senha (mínimo 14 caracteres): ')
if not 14 <= len(password) <= 1024 or password != getpass.getpass('Confirme: '):
    raise SystemExit('Senha inválida ou confirmação diferente.')
salt = secrets.token_hex(16)
digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()
lines = path.read_text().splitlines()
lines = [f'LOCAL_AUTH_PASSWORD_HASH={salt}:{digest}' if line.startswith('LOCAL_AUTH_PASSWORD_HASH=') else line for line in lines]
path.write_text('\n'.join(lines) + '\n')
print('Senha alterada. Execute: docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml up -d --force-recreate web')
