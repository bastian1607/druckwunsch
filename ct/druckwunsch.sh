#!/usr/bin/env bash
# Druckwunsch – Kanban-Board für 3D-Druck-Wünsche
# Installation im Stil der Proxmox-VE-Helper-Scripts.
#
#   Auf dem PVE-Host (Shell der Node) ausführen:
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/bastian1607/druckwunsch/main/ct/druckwunsch.sh)"
#
#   Im Container ausführen (oder einfach: update) → aktualisiert die App.
#
# Überschreibbar per Umgebungsvariable: REPO, BRANCH
set -Eeuo pipefail

REPO="${REPO:-bastian1607/druckwunsch}"
BRANCH="${BRANCH:-main}"
APP="Druckwunsch"
NSAPP="druckwunsch"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

# Defaults
var_cpu=1
var_ram=512
var_disk=4
var_hostname="$NSAPP"
var_bridge="vmbr0"
var_port=80

YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; BL=$'\033[36m'; CL=$'\033[m'; BOLD=$'\033[1m'
msg_info()  { echo -e " ${YW}⏳ $1…${CL}"; }
msg_ok()    { echo -e " ${GN}✔️  $1${CL}"; }
msg_error() { echo -e " ${RD}✖️  $1${CL}" >&2; }
trap 'msg_error "Fehler in Zeile $LINENO: $BASH_COMMAND"' ERR

header() {
  clear 2>/dev/null || true
  cat <<EOF
${BL}
   ___                 _                            _
  |   \ _ _ _  _ __ _| |____ __ ___  _ _  ___ __| |_
  | |) | '_| || / _| / /\ V  V / || | ' \(_-</ _| ' \\
  |___/|_|  \_,_\__|_\_\ \_/\_/ \_,_|_||_/__/\__|_||_|
${CL}
  ${BOLD}3D-Druck-Wunschboard für die Familie${CL}

EOF
}

# --------- Im Container: Update ---------
if ! command -v pct >/dev/null 2>&1; then
  if [[ -x /opt/${NSAPP}/install/update.sh ]]; then
    exec /opt/${NSAPP}/install/update.sh "$@"
  fi
  msg_error "Kein Proxmox-Host erkannt und keine bestehende ${APP}-Installation gefunden."
  echo "  Auf dem PVE-Host ausführen, um einen Container anzulegen."
  exit 1
fi

# --------- Auf dem PVE-Host: Container anlegen ---------
header
[[ $EUID -eq 0 ]] || { msg_error "Bitte als root ausführen."; exit 1; }
command -v whiptail >/dev/null || { msg_error "whiptail fehlt (apt install whiptail)."; exit 1; }
if ! pveversion | grep -Eq "pve-manager/(8|9)\."; then
  msg_error "Getestet für Proxmox VE 8.x/9.x. Gefunden: $(pveversion)"
  whiptail --title "$APP" --yesno "Nicht unterstützte PVE-Version. Trotzdem fortfahren?" 8 60 || exit 1
fi

CTID=$(pvesh get /cluster/nextid)
HN="$var_hostname"; CORES="$var_cpu"; RAM="$var_ram"; DISK="$var_disk"; BRIDGE="$var_bridge"
NET="dhcp"; GW=""; PORT="$var_port"

if whiptail --title "$APP" --yesno "Standard-Einstellungen verwenden?\n\n  CT-ID:     $CTID\n  Hostname:  $HN\n  CPU/RAM:   $CORES Kern / $RAM MiB\n  Disk:      $DISK GB\n  Netz:      $BRIDGE, DHCP\n  Port:      $PORT" \
  --yes-button "Standard" --no-button "Erweitert" 16 60; then
  :
else
  CTID=$(whiptail --title "$APP" --inputbox "Container-ID" 8 60 "$CTID" 3>&1 1>&2 2>&3) || exit 1
  HN=$(whiptail --title "$APP" --inputbox "Hostname" 8 60 "$HN" 3>&1 1>&2 2>&3) || exit 1
  CORES=$(whiptail --title "$APP" --inputbox "CPU-Kerne" 8 60 "$CORES" 3>&1 1>&2 2>&3) || exit 1
  RAM=$(whiptail --title "$APP" --inputbox "RAM in MiB" 8 60 "$RAM" 3>&1 1>&2 2>&3) || exit 1
  DISK=$(whiptail --title "$APP" --inputbox "Disk in GB" 8 60 "$DISK" 3>&1 1>&2 2>&3) || exit 1
  BRIDGE=$(whiptail --title "$APP" --inputbox "Netzwerk-Bridge" 8 60 "$BRIDGE" 3>&1 1>&2 2>&3) || exit 1
  NET=$(whiptail --title "$APP" --inputbox "IPv4 (dhcp oder CIDR, z. B. 192.168.1.50/24)" 8 60 "$NET" 3>&1 1>&2 2>&3) || exit 1
  if [[ "$NET" != "dhcp" ]]; then
    GW=$(whiptail --title "$APP" --inputbox "Gateway" 8 60 "" 3>&1 1>&2 2>&3) || exit 1
  fi
  PORT=$(whiptail --title "$APP" --inputbox "Web-Port der App" 8 60 "$PORT" 3>&1 1>&2 2>&3) || exit 1
fi
pct status "$CTID" >/dev/null 2>&1 && { msg_error "CT-ID $CTID ist bereits vergeben."; exit 1; }

# Storage wählen
pick_storage() { # $1 = content (vztmpl|rootdir)
  local list menu=() count
  list=$(pvesm status -content "$1" | awk 'NR>1 {printf "%s %.1fGB\n", $1, $6/1024/1024}')
  count=$(echo "$list" | grep -c . || true)
  [[ $count -gt 0 ]] || { msg_error "Kein Storage mit Inhaltstyp '$1' gefunden."; exit 1; }
  if [[ $count -eq 1 ]]; then echo "$list" | awk '{print $1}'; return; fi
  while read -r name free; do menu+=("$name" "frei: $free"); done <<<"$list"
  whiptail --title "$APP" --menu "Storage für $1 wählen" 16 60 6 "${menu[@]}" 3>&1 1>&2 2>&3
}
TEMPLATE_STORAGE=$(pick_storage vztmpl) || exit 1
CONTAINER_STORAGE=$(pick_storage rootdir) || exit 1
msg_ok "Storage: Template → ${TEMPLATE_STORAGE}, Container → ${CONTAINER_STORAGE}"

# Debian-Template besorgen (neuestes Debian 13, sonst 12)
msg_info "Aktualisiere Template-Liste"
pveam update >/dev/null 2>&1 || true
TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E '^debian-13-standard' | sort -V | tail -1)
[[ -n "$TEMPLATE" ]] || TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E '^debian-12-standard' | sort -V | tail -1)
[[ -n "$TEMPLATE" ]] || { msg_error "Kein Debian-Template gefunden."; exit 1; }
msg_ok "Template: $TEMPLATE"
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  msg_info "Lade Template herunter"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
  msg_ok "Template heruntergeladen"
fi

# Container erstellen
NET0="name=eth0,bridge=${BRIDGE},ip=${NET}"
[[ -n "$GW" ]] && NET0+=",gw=${GW}"
msg_info "Erstelle LXC-Container $CTID"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$HN" --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "${CONTAINER_STORAGE}:${DISK}" --net0 "$NET0" \
  --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian \
  --tags "3d-druck;${NSAPP}" >/dev/null
pct set "$CTID" --description "<div align='center'><h2>🖨️ ${APP}</h2><p>3D-Druck-Wunschboard<br>Update: im Container <code>update</code> ausführen</p><p><a href='https://github.com/${REPO}'>github.com/${REPO}</a></p></div>" >/dev/null
msg_ok "Container $CTID erstellt"

msg_info "Starte Container"
pct start "$CTID"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || { msg_error "Container hat kein Netzwerk/DNS."; exit 1; }
msg_ok "Container läuft, Netzwerk ok"

# Installationsskript in den Container kopieren und ausführen
TMP=$(mktemp)
curl -fsSL "${RAW}/install/install.sh" -o "$TMP" || { msg_error "Konnte ${RAW}/install/install.sh nicht laden."; exit 1; }
pct push "$CTID" "$TMP" /root/druckwunsch-install.sh --perms 755
rm -f "$TMP"
pct exec "$CTID" -- env REPO="$REPO" BRANCH="$BRANCH" PORT="$PORT" bash /root/druckwunsch-install.sh
pct exec "$CTID" -- rm -f /root/druckwunsch-install.sh

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
URL="http://${IP}"; [[ "$PORT" != "80" ]] && URL+=":${PORT}"
echo
msg_ok "${APP} wurde erfolgreich installiert!"
echo -e "   ${BOLD}Aufrufen:${CL}  ${BL}${URL}${CL}"
echo -e "   ${BOLD}Update:${CL}    im Container (pct enter ${CTID}) einfach ${GN}update${CL} eingeben"
echo -e "   Beim ersten Aufruf legst du dich selbst als Admin an."
echo
