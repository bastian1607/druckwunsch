#!/usr/bin/env bash
# Läuft IM Container. Wird von ct/druckwunsch.sh aufgerufen,
# kann aber auch manuell auf einem frischen Debian 12/13 ausgeführt werden.
set -Eeuo pipefail

REPO="${REPO:-bastian1607/druckwunsch}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-80}"
NODE_MAJOR="${NODE_MAJOR:-24}"
APP_DIR=/opt/druckwunsch
DATA_DIR=/var/lib/druckwunsch
SVC_USER=druckwunsch

YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; CL=$'\033[m'
msg_info() { echo -e " ${YW}⏳ $1…${CL}"; }
msg_ok()   { echo -e " ${GN}✔️  $1${CL}"; }
trap 'echo -e " ${RD}✖️  Fehler in Zeile $LINENO: $BASH_COMMAND${CL}" >&2' ERR
export DEBIAN_FRONTEND=noninteractive

msg_info "Aktualisiere Betriebssystem"
apt-get update -qq
apt-get -y -qq -o Dpkg::Options::="--force-confold" dist-upgrade >/dev/null
apt-get -y -qq install curl ca-certificates gnupg git sudo >/dev/null
msg_ok "Betriebssystem aktuell"

msg_info "Installiere Node.js ${NODE_MAJOR}"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get -y -qq install nodejs >/dev/null
msg_ok "Node.js $(node -v) installiert"

msg_info "Installiere Druckwunsch"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/backups"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chmod +x "$APP_DIR"/install/*.sh
msg_ok "Druckwunsch installiert ($(git rev-parse --short HEAD))"

msg_info "Richte Dienst ein"
# Einmal-Code für die Ersteinrichtung (bleibt bei erneutem Lauf erhalten)
SETUP_TOKEN=$(. /etc/default/druckwunsch 2>/dev/null; echo "${SETUP_TOKEN:-}")
[[ -n "$SETUP_TOKEN" ]] || SETUP_TOKEN=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
cat >/etc/default/druckwunsch <<EOF
# Konfiguration für Druckwunsch – nach Änderung: systemctl restart druckwunsch
PORT=${PORT}
HOST=0.0.0.0
DATA_DIR=${DATA_DIR}
NODE_ENV=production
# Code, den man beim allerersten Aufruf eingeben muss, um Admin zu werden
SETUP_TOKEN=${SETUP_TOKEN}
# Welchen Reverse-Proxys vertraut wird (X-Forwarded-For/-Proto).
# Standard: private Netze. Läuft cloudflared im selben Container, reicht: loopback
TRUST_PROXY="loopback, linklocal, uniquelocal"
EOF
chmod 640 /etc/default/druckwunsch
cat >/etc/systemd/system/druckwunsch.service <<EOF
[Unit]
Description=Druckwunsch – 3D-Druck-Wunschboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/default/druckwunsch
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning ${APP_DIR}/server.js
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q --now druckwunsch
msg_ok "Dienst läuft"

# Befehl "update" bereitstellen (wie bei den Helper-Scripts)
cat >/usr/bin/update <<'EOF'
#!/usr/bin/env bash
exec /opt/druckwunsch/install/update.sh "$@"
EOF
chmod +x /usr/bin/update

# Kleine MOTD-Info
cat >/etc/update-motd.d/99-druckwunsch <<'EOF'
#!/bin/sh
. /etc/default/druckwunsch 2>/dev/null
IP=$(hostname -I | awk '{print $1}')
echo ""
echo "  🖨️  Druckwunsch läuft auf http://${IP}$( [ "$PORT" = "80" ] || echo ":$PORT" )"
echo "      Aktualisieren: update   |   Logs: journalctl -u druckwunsch -f"
echo ""
EOF
chmod +x /etc/update-motd.d/99-druckwunsch

# Root-Autologin auf der PVE-Konsole (wie Helper-Scripts)
mkdir -p /etc/systemd/system/container-getty@1.service.d
cat >/etc/systemd/system/container-getty@1.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud tty%I 115200,38400,9600 $TERM
EOF
systemctl daemon-reload

msg_info "Räume auf"
apt-get -y -qq autoremove >/dev/null
apt-get -y -qq autoclean >/dev/null
msg_ok "Fertig"

sleep 1
systemctl is-active -q druckwunsch || { journalctl -u druckwunsch -n 30 --no-pager; exit 1; }
