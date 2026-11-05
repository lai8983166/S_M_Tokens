#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$1
release=$2
expected_caddy=$3
base_path=$4
port=$5
[[ "$root" =~ ^/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$ && "$root" != /opt && "$root" != /root && "$root" != /var && "$root" != /etc && "$root" != /usr && "$root" != /home ]] || exit 2
[[ "$release" =~ ^[0-9]{14}-[a-f0-9]{8}$ && "$expected_caddy" =~ ^[a-f0-9]{64}$ && "$base_path" =~ ^(/[a-zA-Z0-9_-]+)*$ && "$port" =~ ^[0-9]{4,5}$ ]] || exit 2
[[ $(id -u) = 0 ]] || { echo 'Native deployment requires root' >&2; exit 2; }
for tool in curl tar sha256sum caddy flock systemctl runuser; do command -v "$tool" >/dev/null; done
mkdir -p "$root/releases" "$root/tools"
chmod 755 "$root" "$root/releases" "$root/tools"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Deployment already running' >&2; exit 2; }
target="$root/releases/$release"
cd "$target"
actual=$(sha256sum /etc/caddy/Caddyfile | cut -d ' ' -f1)
previous=''
if [[ -L "$root/current" ]]; then previous=$(readlink -f "$root/current"); fi
case "$previous" in ''|"$root"/releases/*) ;; *) exit 2;; esac
if [[ "$actual" != "$expected_caddy" ]]; then
  [[ -n "$previous" && -f "$previous/Caddyfile" ]] && cmp -s "$previous/Caddyfile" /etc/caddy/Caddyfile || { echo 'Caddy changed since inspection; refusing to overwrite unrelated config' >&2; exit 2; }
fi
if [[ -z "$previous" ]] && ss -ltnH "sport = :$port" | grep -q .; then echo 'Relay port already in use' >&2; exit 2; fi
version=v24.14.1
case $(uname -m) in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo 'Unsupported CPU' >&2; exit 2;; esac
node_dir="$root/tools/node-$version-linux-$arch"
if [[ ! -x "$node_dir/bin/node" ]]; then
  archive="node-$version-linux-$arch.tar.xz"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/$archive" -o "$root/tools/$archive"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$root/tools/SHASUMS256.txt"
  (cd "$root/tools"; grep " $archive\$" SHASUMS256.txt | sha256sum --check --strict; tar -xJf "$archive")
fi
chmod -R a+rX "$node_dir"
if ! id local-codex-relay >/dev/null 2>&1; then useradd --system --home /var/lib/local-codex-relay --shell /usr/sbin/nologin local-codex-relay; fi
install -d -m 750 -o local-codex-relay -g local-codex-relay /var/lib/local-codex-relay /var/cache/local-codex-relay
# Build as an unprivileged account; no model secrets exist on this host.
chmod -R a+rX "$target"
chown -R local-codex-relay:local-codex-relay "$target"
chown root:root "$target/relay.env"
chmod 600 "$target/relay.env"
runuser -u local-codex-relay -- env PATH="$node_dir/bin:/usr/bin:/bin" npm ci --cache /var/cache/local-codex-relay
runuser -u local-codex-relay -- env PATH="$node_dir/bin:/usr/bin:/bin" VITE_BASE_PATH="$base_path/" npm run build
chown -R root:root "$target"
chmod -R a+rX "$target"
chmod 600 "$target/relay.env"
caddy validate --config "$target/Caddyfile" --adapter caddyfile
cp -p /etc/caddy/Caddyfile "$root/caddy-before-$release"
if [[ -f /etc/systemd/system/local-codex-relay.service ]]; then cp -p /etc/systemd/system/local-codex-relay.service "$root/unit-before-$release"; fi
cat > /etc/systemd/system/local-codex-relay.service <<EOF
[Unit]
Description=Local Codex Web Relay
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=local-codex-relay
Group=local-codex-relay
WorkingDirectory=$target
EnvironmentFile=$target/relay.env
ExecStart=$node_dir/bin/node --import tsx apps/relay/main.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/local-codex-relay
[Install]
WantedBy=multi-user.target
EOF
rollback() {
  trap - ERR
  echo 'Deployment failed; restoring previous Caddy and service configuration.' >&2
  cp -p "$root/caddy-before-$release" /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy || true
  if [[ -f "$root/unit-before-$release" ]]; then
    cp -p "$root/unit-before-$release" /etc/systemd/system/local-codex-relay.service
    systemctl daemon-reload
    systemctl restart local-codex-relay || true
  else systemctl stop local-codex-relay || true; fi
  exit 1
}
trap rollback ERR
systemctl daemon-reload
systemctl enable local-codex-relay
systemctl restart local-codex-relay
ready=0
for i in $(seq 1 45); do if curl --fail --silent "http://127.0.0.1:$port/health" >/dev/null; then ready=1; break; fi; sleep 2; done
[[ $ready = 1 ]]
install -m 644 "$target/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy
ln -sfn "$target" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
trap - ERR
echo "DEPLOYED $release via systemd; existing Caddy fallback preserved"
