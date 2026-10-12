# homebridge-ringintercom-reolink

Homebridge-Plugin, das einen **Ring Intercom** und eine **Reolink-Kamera** zu einer HomeKit-Videotürklingel verbindet. Damit wird Scrypted für diese Aufgabe nicht mehr gebraucht.

| Funktion | Quelle |
|---|---|
| Livebild und Snapshot | Reolink-Kamera (RTSP, HTTP-FLV oder RTMP) |
| HomeKit Secure Video (HKSV) mit Vorlauf | Reolink-Kamera, über einen eigenen Rebroadcast-Puffer |
| Bewegungsmelder (startet die HKSV-Aufnahme) | Reolink-Kamera |
| Klingel-Mitteilung mit Bild | Ring Intercom |
| Ton im Livebild und Gegensprechen | Ring Intercom |
| Türöffner | Ring Intercom |
| Akkustand | Ring Intercom (falls vorhanden) |

## So funktioniert der Rebroadcast

Das Plugin geht so vor wie das Rebroadcast-Plugin von Scrypted:

- Es hält **eine dauerhafte Verbindung** zur Kamera.
- Davon behält es die letzten 10 Sekunden im Speicher, jeweils ab einem Schlüsselbild.
- Livebild, HKSV-Aufnahmen und Snapshots greifen alle auf diesen Puffer zu.

Daraus ergibt sich:

- Die Kamera sieht nur eine einzige Verbindung, auch wenn mehrere Geräte gleichzeitig zuschauen und aufnehmen.
- Das Livebild erscheint sofort.
- HKSV-Aufnahmen enthalten die Sekunden **vor** der Bewegung.
- Bricht die Verbindung ab (Kamera-Neustart, WLAN), baut das Plugin sie selbst neu auf.

## Installation (Raspberry Pi, ohne Build)

```bash
cd ~/scrypted-ringintercom-camera
git pull
sh install-homebridge-plugin.sh
```

Das Skript erkennt selbst, ob Homebridge als Paket (`hb-service`) oder im Docker-Container läuft, installiert das fertige Paket aus `release/` und startet Homebridge neu.

### Einrichtung in der Homebridge-Oberfläche (UI X)

Öffne **Plugins → Ring Intercom + Reolink → Einstellungen**. Die Seite hat drei Teile:

1. **Ring-Konto:** E-Mail und Passwort eingeben, dann auf *Bei Ring anmelden* klicken.
   - Ist bei Ring die Zwei-Faktor-Anmeldung aktiv, erscheint ein Feld für den Code aus der SMS, der E-Mail oder der Authenticator-App.
   - Der Ring-Token wird danach automatisch gespeichert. E-Mail und Passwort werden **nicht** gespeichert.
   - Die gefundenen Intercoms werden angezeigt, und für jedes wird eine Türklingel vorbereitet.
2. **Reolink-Daten:** Weiter unten IP-Adresse, Benutzer und Passwort der Kamera eintragen.
3. **Kamera testen:** prüft die Verbindung (auch mit noch nicht gespeicherten Werten), zeigt Auflösung, Codec und Bildrate von Main- und Sub-Stream sowie ein aktuelles Bild. Bei H.265 gibt es einen Hinweis, weil HomeKit H.264 braucht.

Danach:

1. **Speichern** und Homebridge neu starten. Empfohlen: das Plugin als **Child Bridge** laufen lassen (Plugin-Menü → Bridge-Einstellungen).
2. Die Türklingel wird als **eigenes Gerät** veröffentlicht, nicht über die Homebridge-Bridge. Füge sie in der Home-App so hinzu:
   1. Tippe auf **+ → Gerät hinzufügen → Weitere Optionen → Vordereingang**.
   2. Gib den Code der Homebridge ein (Homebridge-Startseite bzw. Log).
3. Aktiviere in der Home-App in den Kamera-Einstellungen **Streamen & Aufnehmen** (HKSV). Dafür ist eine Steuerzentrale (HomePod/Apple TV) und iCloud+ nötig.

Ohne Homebridge-Oberfläche lässt sich der Token alternativ auf der Kommandozeile erzeugen (`npx -p ring-client-api ring-auth-cli`) und als `refreshToken` in die config.json eintragen. Ring erneuert den Token regelmäßig, das Plugin speichert den jeweils neuesten selbst in `ringintercom-reolink.json` im Homebridge-Ordner.

### Beispiel-Konfiguration

```json
{
  "platform": "RingIntercomReolink",
  "name": "Ring Intercom Reolink",
  "refreshToken": "eyJ...",
  "cameras": [
    {
      "name": "Vordereingang",
      "reolinkHost": "192.168.0.42",
      "reolinkUsername": "admin",
      "reolinkPassword": "geheim",
      "reolinkProtocol": "rtsp",
      "liveStream": "main",
      "recordingStream": "main"
    }
  ]
}
```

## Empfohlene Einstellungen der Reolink-Kamera

Einstellen in der Reolink-App unter **Anzeige / Stream → Klar (Main)**:

- **Codec H.264.** HomeKit kann kein H.265. Der RTSP-Pfad bleibt auf `h264Preview`.
- **I-Frame-Intervall 1x oder 2x** der Bildrate. HKSV braucht spätestens alle 4 Sekunden ein Schlüsselbild.
- **Bildrate 15 fps** und eine mittlere Bitrate reichen völlig und entlasten das WLAN.
- Wenn RTSP unzuverlässig ist (Bild hängt, häufige Abbrüche), stell das **Stream-Protokoll auf HTTP-FLV**. Dafür müssen in der Reolink-App unter *Netzwerk → Erweitert → Server-Einstellungen* HTTP und RTMP aktiviert sein.

## Einschränkungen

- Ton und Gegensprechen über den Ring Intercom nutzen die (inoffizielle) Live-Ansicht von Ring. Das ist dieselbe Technik wie im Scrypted-Plugin. Gelingt der Aufbau nicht, bleibt das Livebild ohne Ton, das Bild läuft weiter.
- Das Video wird nicht umkodiert, sondern so weitergegeben, wie die Kamera es liefert. Für Fernzugriff über Mobilfunk kann **Stream für das Livebild = Sub** sinnvoll sein.
