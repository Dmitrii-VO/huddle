#!/bin/sh
# One-shot VPS setup (Ubuntu). Run from the cloned repo: sudo sh deploy/setup.sh
# Safe to re-run after `git pull` to restart with new code.
set -e
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
IP=$(curl -4 -fsS https://api.ipify.org)
DOMAIN="$(echo "$IP" | tr . -).sslip.io"   # free hostname that resolves to our IP
SECRET=$(openssl rand -hex 32)

# Node 22, Caddy (auto HTTPS), coturn (TURN relay)
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
fi
apt-get install -y nodejs caddy coturn

cd "$APP_DIR" && npm install --omit=dev

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy localhost:3000
}
EOF

cat > /etc/turnserver.conf <<EOF
listening-port=3478
external-ip=$IP
realm=$DOMAIN
use-auth-secret
static-auth-secret=$SECRET
fingerprint
min-port=49160
max-port=49200
no-cli
no-tls
no-dtls
# never relay into private networks
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
EOF
echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn

cat > /etc/systemd/system/huddle.service <<EOF
[Unit]
Description=Huddle
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Environment=TURN_HOST=$DOMAIN
Environment=TURN_SECRET=$SECRET
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
EOF

if ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
  ufw allow 3478; ufw allow 49160:49200/udp
fi

systemctl daemon-reload
systemctl enable huddle coturn caddy
systemctl restart huddle coturn caddy

echo
echo "Готово: https://$DOMAIN"
echo "Если у провайдера есть свой файрвол в панели — откройте там 80, 443, 3478 (TCP+UDP), 49160-49200/UDP."
