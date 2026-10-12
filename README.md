# Ring Intercom + Reolink Camera (Scrypted Plugin)

Dieses Plugin verbindet einen **Ring Intercom** mit dem Bild einer **Reolink-Kamera** zu **einem** Türklingel-Gerät in Scrypted:

| Funktion | Quelle |
| --- | --- |
| Livebild, Snapshots, Aufzeichnung | Reolink-Kamera (direkt per IP) |
| Klingel-Erkennung (`BinarySensor`, Doorbell) | Ring Intercom (Push-Benachrichtigung von Ring) |
| Bewegung (`MotionSensor`, für HomeKit Secure Video) | Reolink-Kamera (optional zusätzlich beim Klingeln) |
| 2-Wege-Audio (sprechen **und** hören) | Ring Intercom (Ring WebRTC Live-Sitzung) |
| Türöffner (`Lock`) | Ring Intercom (`unlock_door`) |
| Akkustand | Ring Intercom |

Der Code basiert auf dem offiziellen [Scrypted Ring Plugin](https://github.com/koush/scrypted/tree/main/plugins/ring) (Login, 2FA, Refresh-Token) und dem [Scrypted Reolink Plugin](https://github.com/koush/scrypted/tree/main/plugins/reolink) (RTSP-Streams, Snapshot-API). Für Ring wird [`ring-client-api`](https://github.com/dgreif/ring) verwendet.
Das offizielle Ring-Plugin erkennt Intercoms gar nicht. Dieses Plugin nutzt die Intercom-Unterstützung von `ring-client-api` (Klingel, Türöffner) und baut die Live-Audio-Sitzung über dieselbe WebRTC-Signalisierung auf, die Ring auch für Kameras verwendet.

## Neu: Homebridge-Variante (ohne Scrypted)

Unter [`homebridge-ringintercom-reolink/`](homebridge-ringintercom-reolink/) gibt es dieselben Funktionen als **Homebridge-Plugin**:

- Livebild
- HomeKit Secure Video mit eigenem Rebroadcast-Puffer
- Klingel
- Ton und Gegensprechen über den Intercom
- Türöffner

Wer Scrypted nur für diese Türklingel nutzt, kann Scrypted damit ganz ersetzen. Installation auf dem Pi, ohne Build:

```bash
cd ~/scrypted-ringintercom-camera
git pull
sh install-homebridge-plugin.sh
```

Einrichtung und Ring-Token: siehe [homebridge-ringintercom-reolink/README.md](homebridge-ringintercom-reolink/README.md).

## Installation

### Fertig gebaut (empfohlen, z. B. auf dem Raspberry Pi)

Das Bauen braucht viel Arbeitsspeicher und kann einen Raspberry Pi einfrieren. Das fertige Plugin liegt deshalb unter `release/plugin.zip` im Repo, gebaut wird nichts:

```bash
git clone https://github.com/Luftloch80/scrypted-ringintercom-camera.git
cd scrypted-ringintercom-camera
npx scrypted login 192.168.0.50     # einmalig
sh deploy-prebuilt.sh 192.168.0.50
```

Für ein Update reicht `git pull` und danach wieder `sh deploy-prebuilt.sh 192.168.0.50`. Nötig sind nur `curl` und `python3`, beide sind auf Raspberry Pi OS vorinstalliert.

### Selbst bauen (auf einem PC)

```bash
npm install
npm run build                 # erzeugt out/plugin.zip
npx scrypted login <scrypted-ip>
npm run scrypted-deploy <scrypted-ip>
```

## Einrichtung

1. **Plugin-Einstellungen**: Ring E-Mail und Passwort eintragen. Wenn Ring einen Code schickt, diesen im Feld **Zwei-Faktor-Code** eintragen.
2. Pro Ring Intercom legt das Plugin zwei Geräte an:
   - **`<Name>`**: Türklingel mit Kamera, Klingel und 2-Wege-Audio
   - **`<Name> Türöffner`**: Schloss zum Öffnen der Tür
3. In der Türklingel unter **Reolink** IP-Adresse, Benutzer, Passwort und Kanal (bei Einzelkameras `0`) eintragen. Für 4K/H.265-Modelle als RTSP-Pfad `h265Preview` wählen. RTSP muss in der Reolink-App bzw. im Web-UI aktiviert sein (*Netzwerk → Erweitert → Server-Einstellungen*).

## Streams und Audio

Die Türklingel bietet diese Streams an:

| Stream | Video | Audio | Prebuffer |
| --- | --- | --- | --- |
| `Reolink Main` / `Reolink Sub` | Kamera | Mikrofon der Kamera | ja |
| `Kamera + Ring Intercom Audio` | Kamera | **Türsprechstelle über Ring** (nach dem Klingeln), sonst Kamera | nein (nur bei Bedarf) |

Der Intercom-Stream baut nur während der Wiedergabe eine Ring-Live-Sitzung auf und beendet sie wenige Sekunden nach dem Schließen wieder. So wird der Akku des Intercoms geschont. Unter *Prebuffered Streams* darf deshalb nur `Reolink Main` angehakt sein. Der Akkustand des Intercoms wird beim Gerät *Türöffner* angezeigt, nicht bei der Türklingel. Sonst würde Rebroadcast die Kamera für akkubetrieben halten und das Vorpuffern abschalten. Der Ton im Intercom-Stream ist Opus. Das Bild für den Intercom-Stream holt sich das Plugin aus dem Rebroadcast-Puffer von `Reolink Main` und öffnet keine zweite Verbindung zur Kamera. Der RTSP-Server der Reolink bringt die Pakete zweier gleichzeitiger Verbindungen durcheinander (`bad cseq`), dann funktionieren beide nicht mehr. Außerhalb der Minuten nach dem Klingeln wird der Kamera-Stream mit Kamera-Ton unverändert durchgereicht (ohne ffmpeg). Das Livebild beginnt mit dem letzten Schlüsselbild aus dem Puffer. Damit es schnell erscheint, in der Reolink-App das I-Frame-Intervall auf 1x stellen (ein Schlüsselbild pro Sekunde).

**Was hört man im Livebild?**

- Standard: das Mikrofon der Kamera. Gegensprechen geht trotzdem immer über den Ring Intercom.
- Wenn man im Livebild die Türsprechstelle hören möchte: in der Türklingel unter **Extensions → Rebroadcast** bei *Local Stream* und *Remote Stream* den Stream `Kamera + Ring Intercom Audio` auswählen. *Remote Recording Stream* (HKSV) und *Local Recording Stream* bleiben Kamera-Streams.
- Der Intercom-Stream steht immer an letzter Stelle und hat keine Auflösungsangabe. So wählt Rebroadcast ihn nie automatisch aus, zum Beispiel nicht für Aufnahmen.
- Der Intercom-Stream liefert das Bild sofort. Bis Audio von Ring kommt, und auch wenn Ring die Sitzung ablehnt, läuft Stille mit.

**Intercom nur nach dem Klingeln** (Einstellung *Intercom nach dem Klingeln aktiv (Minuten)*, Standard 5):

- In den ersten Minuten nach einem Klingeln liefert der Stream `Kamera + Ring Intercom Audio` den Ton der Türsprechstelle, und Gegensprechen geht über den Ring Intercom.
- Außerhalb dieser Zeit liefert derselbe Stream den Ton der Kamera, und Gegensprechen ist aus. Ein Livebild ohne vorheriges Klingeln baut also keine Ring-Sitzung auf.
- Ist beim Klingeln noch ein Livebild mit Kamera-Ton offen, wird es beendet. Das nächste Livebild startet dann mit dem Intercom-Ton.
- `0` bedeutet: Der Intercom ist immer aktiv (bisheriges Verhalten).

**Gegensprechen** (HomeKit, Scrypted-App, WebRTC): Das Audio wird nach Opus (oder PCMU, je nachdem, was Ring aushandelt) umgewandelt und an den Lautsprecher der Türsprechstelle gesendet.

## HomeKit Secure Video

HKSV wird vom HomeKit-Plugin von Scrypted bereitgestellt, sobald ein Gerät einen Bewegungssensor meldet. Die Türklingel meldet Bewegung so:

- **Bewegungserkennung „Kamera“**: Der Bewegungsstatus der Reolink wird alle 2 s abgefragt (`GetMdState`).
- **Klingeln löst Bewegung aus** (Standard: an): Beim Klingeln wird ebenfalls eine Bewegung gemeldet, damit HKSV aufnimmt.

Einrichtung:

1. Nach dem Update das **HomeKit-Plugin neu starten**. Falls die Aufnahme-Optionen in der Home-App nicht erscheinen, die Türklingel in der Home-App entfernen und neu koppeln.
2. In der Home-App: Türklingel → Einstellungen → **Aufnahme-Optionen** → *Streamen & Aufnehmen*.
3. In Scrypted unter **Extensions → Rebroadcast** muss der *Remote Recording Stream* ein Kamera-Stream sein, der vorgepuffert wird. Das ist die Standard-Einstellung.

Die Option „HomeKit Secure Video 3“ im HomeKit-Plugin ist experimentell und wird für HKSV nicht benötigt.

## Klingel und Türöffner

- Klingelt jemand an der Türsprechstelle, schickt Ring eine Push-Benachrichtigung. Das Gerät setzt dann `binaryState` (Doorbell) für die eingestellte **Klingel-Dauer** (Standard 10 s).
- Der **Türöffner** löst den Summer über Ring aus. Er zeigt kurz „entriegelt“ und springt dann wieder auf „verriegelt“.

## Hinweise und Einschränkungen

- Das 2-Wege-Audio mit dem Intercom nutzt eine Ring-Schnittstelle, die Ring nicht offiziell dokumentiert. Wenn Ring etwas ändert, braucht es meist ein Update von `ring-client-api`.
- Video und Intercom-Audio kommen aus zwei Geräten und laufen über die Ring-Cloud. Das Audio kann deshalb etwas hinter dem Bild liegen.
- In den Einstellungen des Intercoms in der Ring-App muss Live-Ansicht/Live-Gespräch erlaubt sein.
