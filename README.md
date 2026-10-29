# Huddle

Video calls in the browser for 1:1 lessons: room by link, camera/mic, screen share, chat.
Media goes peer-to-peer (WebRTC); the server only does signaling and TURN fallback.

## Local

    npm install
    npm start        # http://localhost:3000 — open in two tabs
    npm test         # signaling smoke test

## Production

Live at https://176-108-255-4.sslip.io on the `cloud` VPS, behind the existing nginx
(`/etc/nginx/sites-enabled/huddle.conf`, certbot cert), app on 127.0.0.1:3020 (`huddle.service`),
coturn on 3478. Update: `sh deploy/update.sh`.

## Fresh VPS (Ubuntu, nothing on 80/443)

    git clone <repo> /opt/huddle && cd /opt/huddle
    sudo sh deploy/setup.sh

Installs Node, Caddy (HTTPS via `<ip-with-dashes>.sslip.io`, no domain needed) and coturn.
Open in the provider's firewall: 80, 443, 3478 TCP+UDP, 49160–49200 UDP.
