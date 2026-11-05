#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Called with a validated absolute directory and a generated release ID.
root=$1
release=$2
[[ "$root" =~ ^/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$ && "$root" != / && "$root" != /home && "$root" != /root && "$root" != /opt && "$root" != /usr && "$root" != /var ]] || { echo 'Unsafe deployment directory' >&2; exit 2; }
[[ "$release" =~ ^[0-9]{14}-[a-f0-9]{8}$ ]] || exit 2
command -v docker >/dev/null || { echo 'Install Docker Engine and Compose v2+ first; see deploy/README.md' >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo 'SSH user must have access to Docker' >&2; exit 2; }
docker compose version >/dev/null
docker compose up --help | grep -q -- --wait || { echo 'Docker Compose with --wait is required' >&2; exit 2; }
command -v flock >/dev/null || { echo 'flock (util-linux) is required' >&2; exit 2; }
mkdir -p "$root/releases"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 2; }
cd "$root/releases/$release"
[[ -f relay.env && -f Caddyfile && -f compose.yaml ]] || exit 2
chmod 600 relay.env Caddyfile
printf 'RELEASE_ID=%s\n' "$release" > .env
printf 'VITE_BASE_PATH=%s\n' "$(cat build-path)" >> .env
previous=''
if [[ -L "$root/current" ]]; then previous=$(readlink -f "$root/current"); fi
case "$previous" in ''|"$root"/releases/*) ;; *) echo 'Unexpected current symlink' >&2; exit 2;; esac
docker compose config --quiet
docker compose build --pull relay
# Reject invalid Caddy config before replacing any running service.
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
if ! docker compose up -d --wait --wait-timeout 180; then
  echo 'New deployment failed. Attempting to restore previous containers (data volumes retained).' >&2
  if [[ -n "$previous" && -f "$previous/compose.yaml" ]]; then
    (cd "$previous" && docker compose up -d --wait --wait-timeout 180) || echo 'Automatic container rollback failed; inspect Docker state.' >&2
  fi
  exit 1
fi
ln -sfn "$PWD" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
printf 'DEPLOYED %s\n' "$release"
echo 'Relay HTTP port is internal only. Caddy publishes 80/443. No Codex credentials are installed here.'
