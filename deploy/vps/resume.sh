#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
if [[ $EUID -ne 0 ]]; then
  echo 'Execute na VPS: sudo bash deploy/vps/resume.sh' >&2; exit 1
fi
if [[ ! -s deploy/vps/.env ]]; then
  echo 'Primeiro execute bash deploy/vps/install.sh para definir o e-mail e a senha local.' >&2; exit 1
fi
mkdir -p deploy/vps/private
if ! flock -n deploy/vps/private/install.lock true; then
  echo 'A instalação já está em execução. Aguarde e consulte o log existente.'
  exit 0
fi
# Detect a surviving installation started before lock-file support was added.
if command -v pgrep >/dev/null && pgrep -f '^bash (\./)?deploy/vps/install\.sh$' >/dev/null; then
  echo 'Um instalador anterior continua ativo. Aguarde a conclusão antes de retomar.'
  exit 0
fi
log="$PWD/deploy/vps/private/install.log"
printf '\nRetomando a instalação da VPS.\n' >> "$log"
nohup bash deploy/vps/install.sh --foreground >> "$log" 2>&1 < /dev/null &
printf '%s\n' "$!" > deploy/vps/private/install.pid
echo 'Instalação iniciada em segundo plano. Ela continuará se o terminal desconectar.'
printf 'Acompanhe com: tail -f %q\n' "$log"
