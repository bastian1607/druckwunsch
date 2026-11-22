# 🖨️ Druckwunsch

Kanban-Board für 3D-Druck-Wünsche der Familie, mit den Spalten **Zurückgestellt · Wünsche · In Bearbeitung · Fertig**.

- Karten zeigen, wer den Wunsch eingestellt hat, außerdem Tags, Links (Printables, MakerWorld, Thingiverse …), einen Wunschtermin und Kommentare
- Verschieben per Drag & Drop (auf dem Handy: Karte kurz gedrückt halten und an den Rand ziehen) oder per Tipp auf die Status-Knöpfe in der Karte
- Live-Aktualisierung: Änderungen erscheinen bei allen sofort
- Anmeldung per Name + PIN/Passwort (mind. 6 Zeichen). Admin wird nur, wer den Einrichtungs-Code aus der Installation kennt.
- Rechte: Familienmitglieder legen Wünsche an, bearbeiten ihre eigenen und können sie zwischen *Wünsche* und *Zurückgestellt* verschieben. Nur Admins setzen *In Bearbeitung* / *Fertig* und legen die Reihenfolge fest.
- Hell/Dunkel nach Systemeinstellung, auf dem Handy gut bedienbar

## Installation auf Proxmox VE

In der **Shell des PVE-Hosts**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/bastian1607/druckwunsch/main/ct/druckwunsch.sh)"
```

Das Skript legt einen unprivilegierten Debian-LXC an (1 Kern, 512 MiB RAM, 4 GB Disk, DHCP) und installiert Node.js sowie die App als systemd-Dienst auf Port 80. Über „Erweitert“ lassen sich ID, Ressourcen, statische IP und Port anpassen.

Einen anderen Branch oder ein Fork installierst du so:

```bash
REPO=user/repo BRANCH=dev bash -c "$(curl -fsSL https://raw.githubusercontent.com/user/repo/dev/ct/druckwunsch.sh)"
```

## Von außen erreichbar machen

> **Reihenfolge:** Erst im Heimnetz den Admin mit dem Einrichtungs-Code anlegen, *dann* freigeben.

Die App spricht selbst nur HTTP. Stell sie **nie per Portweiterleitung direkt** ins Internet, sondern immer hinter einen Dienst, der HTTPS übernimmt.

**Empfohlen: Cloudflare Tunnel.** Du brauchst keine Portfreigabe, und es funktioniert auch mit DS-Lite/CGNAT (bei vielen Glasfaser- und Kabelanschlüssen). Voraussetzung ist eine eigene Domain bei Cloudflare.
1. Im Cloudflare-Dashboard unter *Zero Trust → Networks → Tunnels* einen Tunnel anlegen.
2. `cloudflared` im Druckwunsch-Container installieren (den Befehl zeigt Cloudflare an).
3. Einen *Public Hostname* anlegen, z. B. `druck.deinedomain.de` → `http://localhost:80`.
4. In `/etc/default/druckwunsch` `TRUST_PROXY=loopback` setzen und `systemctl restart druckwunsch` ausführen.
5. Optional, für noch mehr Sicherheit: eine *Cloudflare Access*-Policy mit E-Mail-Code für die Familienadressen.

**Alternative: Reverse Proxy** (Nginx Proxy Manager, Caddy, Traefik) mit Let's Encrypt, Portfreigabe 443 und DynDNS. Das funktioniert nur mit echter öffentlicher IPv4.
- Bei Nginx Proxy Manager *Websockets Support* aktivieren und unter *Advanced* `proxy_buffering off;` eintragen, damit die Live-Updates (Server-Sent Events) sofort ankommen.
- Läuft der Proxy im LAN, passt `TRUST_PROXY` bereits (private Netze).

**Schutz in der App:**
- Höchstens 5 Fehlversuche pro Person, danach 15 Minuten Sperre. Pro IP sind es 20.
- Ohne Anmeldung gibt die App keine Namen oder Daten heraus.
- Sitzungs-Cookie ist `HttpOnly`, `SameSite`, und hinter HTTPS automatisch `Secure`.
- Content-Security-Policy, Schutz vor Clickjacking und CSRF.

## Update

Im Container (`pct enter <CTID>` oder Konsole) einfach eingeben:

```bash
update
```

Vorher wird die Datenbank nach `/var/lib/druckwunsch/backups/` gesichert (die letzten 10 bleiben erhalten).

## Betrieb

| Was | Wo |
|---|---|
| App | `/opt/druckwunsch` |
| Daten (SQLite) | `/var/lib/druckwunsch/druckwunsch.db` |
| Konfiguration (Port, Proxy, Einrichtungs-Code) | `/etc/default/druckwunsch` |
| Logs | `journalctl -u druckwunsch -f` |

PIN vergessen? Ein Admin kann unter *Menü → Familie & Tags verwalten* eine neue PIN setzen.

## Lokal entwickeln

```bash
npm install
PORT=3000 npm start
```

Benötigt Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`, keine nativen Abhängigkeiten).
