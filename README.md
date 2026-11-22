# 🖨️ Druckwunsch

Kanban-Board für 3D-Druck-Wünsche der Familie, mit den Spalten **Zurückgestellt · Wünsche · In Bearbeitung · Fertig**.

- Karten zeigen, wer den Wunsch eingestellt hat, außerdem Tags, Links (Printables, MakerWorld, Thingiverse …), einen Wunschtermin und Kommentare
- Drag & Drop, auch per Touch (Karte kurz gedrückt halten)
- Live-Aktualisierung: Änderungen erscheinen bei allen sofort
- Anmeldung per Name + PIN. Die erste Person, die sich anlegt, wird Admin.
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
| Konfiguration (Port) | `/etc/default/druckwunsch` |
| Logs | `journalctl -u druckwunsch -f` |

PIN vergessen? Ein Admin kann unter *Menü → Familie & Tags verwalten* eine neue PIN setzen.

## Lokal entwickeln

```bash
npm install
PORT=3000 npm start
```

Benötigt Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`, keine nativen Abhängigkeiten).
