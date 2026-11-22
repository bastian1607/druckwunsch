#!/usr/bin/env bash
# Aktualisiert Druckwunsch im Container. Aufruf: update   (oder: update --force)
set -Eeuo pipefail

APP_DIR=/opt/druckwunsch
DATA_DIR=$(. /etc/default/druckwunsch 2>/dev/null; echo "${DATA_DIR:-/var/lib/druckwunsch}")
YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; CL=$'\033[m'
msg_info() { echo -e " ${YW}⏳ $1…${CL}"; }
msg_ok()   { echo -e " ${GN}✔️  $1${CL}"; }
msg_error(){ echo -e " ${RD}✖️  $1${CL}" >&2; }
trap 'msg_error "Fehler in Zeile $LINENO: $BASH_COMMAND"' ERR

[[ $EUID -eq 0 ]] || { msg_error "Bitte als root ausführen."; exit 1; }
[[ -d "$APP_DIR/.git" ]] || { msg_error "Keine Installation in $APP_DIR gefunden."; exit 1; }
cd "$APP_DIR"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

BRANCH=$(git rev-parse --abbrev-ref HEAD)
msg_info "Prüfe auf Updates (Branch $BRANCH)"
git fetch -q --depth 1 origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse FETCH_HEAD)
if [[ "$LOCAL" == "$REMOTE" && "${1:-}" != "--force" ]]; then
  msg_ok "Druckwunsch ist aktuell ($(git rev-parse --short HEAD)). Mit 'update --force' trotzdem neu installieren."
  exit 0
fi
msg_ok "Update verfügbar: ${LOCAL:0:7} → ${REMOTE:0:7}"

msg_info "Stoppe Dienst"
systemctl stop druckwunsch
msg_ok "Dienst gestoppt"

msg_info "Sichere Datenbank"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DATA_DIR/backups"
for f in "$DATA_DIR"/druckwunsch.db "$DATA_DIR"/druckwunsch.db-wal; do
  [[ -f "$f" ]] && cp -a "$f" "$DATA_DIR/backups/$(basename "$f").$STAMP"
done
# nur die letzten 10 Sicherungen behalten
ls -1t "$DATA_DIR"/backups/druckwunsch.db.* 2>/dev/null | tail -n +11 | while read -r old; do
  rm -f "$old" "${old/druckwunsch.db./druckwunsch.db-wal.}"
done
msg_ok "Sicherung: $DATA_DIR/backups/*.$STAMP"

msg_info "Aktualisiere App"
git reset -q --hard FETCH_HEAD
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chmod +x "$APP_DIR"/install/*.sh
msg_ok "App aktualisiert"

msg_info "Aktualisiere Node.js-Paket"
apt-get update -qq && apt-get -y -qq install --only-upgrade nodejs >/dev/null
msg_ok "Node.js $(node -v)"

msg_info "Starte Dienst"
systemctl start druckwunsch
sleep 2
if systemctl is-active -q druckwunsch; then
  msg_ok "Druckwunsch läuft wieder (Version $(node -p "require('./package.json').version"), $(git rev-parse --short HEAD))"
else
  msg_error "Dienst startet nicht. Logs:"
  journalctl -u druckwunsch -n 30 --no-pager
  exit 1
fi
