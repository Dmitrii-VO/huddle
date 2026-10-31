# Huddle

Video calls in the browser for 1:1 lessons: room by link, camera/mic, screen share, chat.
Media goes peer-to-peer (WebRTC); the server only does signaling and TURN fallback.

## Desktop app (`app/`)

The site in an Electron window, plus what a browser can't do while sharing the screen:
a click-through overlay for drawing, a floating bar over full-screen slides, and the child's taps
on the teacher's slides. The other side needs only a browser.

### Lesson with interactive PowerPoint slides

The slides use trigger animations: the child clicks pictures, the teacher turns slides.

1. Teacher (app): «Демонстрация» → slide show in PowerPoint, the normal one, **not** Presenter View
   (on one monitor the child would see the notes and tap on them).
2. Teacher: «Ученик нажимает» on the bar over the slides. macOS asks once for Accessibility
   (System Settings → Privacy & Security → Accessibility → Huddle, then restart the app).
3. Child (browser): taps the slides; each tap is a single left click in PowerPoint, the teacher's cursor
   jumps there and back. Both see a red dot where the child tapped.

Safeguards: only single left clicks (no keyboard, drag, right click, wheel, double click), at most one
per 150 ms, never on our bar. Windows: only if the window under the tap is the PowerPoint slide show.
macOS: only while PowerPoint is the front app — a notification or the PowerPoint editor on top would
take the tap, so turn on Do Not Disturb for the lesson. The switch turns itself off when sharing stops
or the other side leaves; a newly joined peer never gets it without the teacher.

### Release

    sh deploy/release-app.sh X.Y.Z   # bump, tag, push; GitHub Actions builds Mac + Windows

Installed apps offer the update. Server changes go out separately with `sh deploy/update.sh`.

## Local

    npm install
    npm start        # http://localhost:3000 — open in two tabs
    npm test         # signaling smoke test

## Production

Live at https://huddle.runterra.ru (old https://176-108-255-4.sslip.io still served) on the `cloud` VPS, behind the existing nginx
(`/etc/nginx/sites-enabled/huddle.conf`, certbot cert), app on 127.0.0.1:3020 (`huddle.service`),
coturn on 3478. Update: `sh deploy/update.sh`.

## Fresh VPS (Ubuntu, nothing on 80/443)

    git clone <repo> /opt/huddle && cd /opt/huddle
    sudo sh deploy/setup.sh

Installs Node, Caddy (HTTPS via `<ip-with-dashes>.sslip.io`, no domain needed) and coturn.
Open in the provider's firewall: 80, 443, 3478 TCP+UDP, 49160–49200 UDP.
