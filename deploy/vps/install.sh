#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ $EUID -ne 0 ]]; then
  echo 'Execute na VPS: sudo bash deploy/vps/install.sh' >&2; exit 1
fi
mkdir -p private
exec 9>private/install.lock
if ! flock -n 9; then
  echo 'Outra instalação está em execução. Aguarde a conclusão antes de tentar novamente.' >&2; exit 1
fi
if ! grep -q 'VERSION_ID="24.04"' /etc/os-release; then
  echo 'Este instalador foi preparado para Ubuntu 24.04.' >&2; exit 1
fi
if [[ ! -f .env ]]; then
  if ss -ltn '( sport = :80 or sport = :443 )' | tail -n +2 | grep -q .; then
    echo 'As portas 80/443 já estão ocupadas. Confira os serviços existentes antes de instalar.' >&2; exit 1
  fi
fi
ram_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
disk_kb=$(df -Pk . | awk 'NR==2 {print $4}')
if (( ram_kb < 7000000 || disk_kb < 30000000 )); then
  echo 'Reserve pelo menos 8 GB de RAM e 30 GB livres para compilar e executar esta configuração. Recomenda-se 16 GB de RAM.' >&2; exit 1
fi
apt-get update
apt-get install -y ca-certificates curl openssl python3
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker.io docker-compose-v2
fi
systemctl enable --now docker
if [[ ! -f .env ]]; then python3 configure.py; fi
if [[ ${1:-} != --foreground ]]; then
  flock -u 9
  exec bash ./resume.sh
fi
compose=(docker compose --env-file .env -f compose.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" build tools
"${compose[@]}" build web
"${compose[@]}" build sandbox
"${compose[@]}" up -d --wait backend redis storage centrifugo ollama
if [[ ! -s private/convex-admin-key ]]; then
  "${compose[@]}" exec -T backend ./generate_admin_key.sh > private/convex-admin-key
  chmod 600 private/convex-admin-key
fi
"${compose[@]}" run --rm -T tools node deploy/vps/bootstrap.mjs env
"${compose[@]}" run --rm -T tools node deploy/vps/bootstrap.mjs deploy
"${compose[@]}" run --rm -T tools node deploy/vps/bootstrap.mjs storage
"${compose[@]}" run --rm -T tools node deploy/vps/bootstrap.mjs sandbox
"${compose[@]}" exec -T ollama ollama pull qwen2.5:3b
"${compose[@]}" up -d web sandbox caddy
echo 'Serviços iniciados. Confira o HTTPS e faça os testes descritos no README antes de considerar a instalação concluída.'
"${compose[@]}" ps
