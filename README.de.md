# NexoWatt OCPP

**NexoWatt OCPP** ist der zentrale OCPP-Server (CSMS) für das **NexoWatt Energy Operation System (EOS)**. Der Adapter bindet AC- und DC-Ladestationen über **OCPP 1.6J, OCPP 2.0.1 und OCPP 2.1** an und stellt Messwerte, Status, Transaktionen, RFID-Daten, SoC, Smart-Charging-Befehle und vollständige OCPP-Nutzdaten als Datenpunkte bereit.

> Der sichtbare Produktname lautet **NexoWatt OCPP**. Die technische Adapter-ID bleibt absichtlich `ocpp21`, damit vorhandene Instanzen, Objektpfade, Installationsskripte und EOS-Zuordnungen kompatibel bleiben.

## Warum die Aktualitätslogik wichtig ist

Viele Ladestationen senden `MeterValues` und `StatusNotification` nur bei einer Änderung. Ein Heartbeat beweist jedoch lediglich, dass die OCPP-Anwendung der Station erreichbar ist; er bestätigt nicht, dass ein alter Leistungswert noch stimmt. NexoWatt OCPP trennt deshalb konsequent zwischen **Verbindung**, **Heartbeat** und **Messwertaktualität**:

1. **Echte OCPP-Nachrichten aktualisieren Datenpunkte immer**, auch wenn sich der Wert nicht geändert hat. Damit wird der Datenpunkt-Zeitstempel zuverlässig erneuert.
2. Solange die Station online ist, werden zwischengespeicherte Status-, Meta-, Transaktions- und Zählerdaten regelmäßig erneut veröffentlicht. Bei mehr Datenpunkten als dem Zykluslimit rotiert der Adapter fair durch den gesamten Bestand; spätere Datenpunkte werden nicht dauerhaft ausgelassen.
3. Der Adapter fordert mit `TriggerMessage` aktiv neue `MeterValues` und `StatusNotification` an, sofern die Station dies unterstützt. Ablehnungen oder fehlende Unterstützung führen automatisch zu einem Backoff. Langsame Antworten blockieren den Health-Watchdog anderer Stationen nicht; OCPP-Befehle besitzen ein korrektes, auf 5–120 Sekunden begrenztes Timeout.
4. Echtzeitwerte werden **pro Datenpunkt** überwacht. Ein neuer Strom- oder Blindleistungswert erneuert deshalb niemals den Zeitstempel eines alten Wirkleistungswerts. `health.dataFresh` wird nur bei aktueller Bezugs-Wirkleistung oder einem protokollseitig sicher abgeleiteten Nullwert gesetzt.
5. Bei einem eindeutig beendeten oder ruhenden Ladevorgang setzt der Adapter gemessene Leistung und Strom sicher auf `0`. Während eines möglicherweise noch aktiven Ladevorgangs wird ein veralteter Wert niemals stillschweigend zu `0` umgedeutet.

## Für das EOS-Lademanagement maßgebliche Datenpunkte

| Datenpunkt | Bedeutung |
|---|---|
| `<Station>.health.online` | OCPP-Anwendung ist innerhalb des Heartbeat-/Aktivitätsfensters erreichbar |
| `<Station>.health.socketConnected` | WebSocket ist technisch verbunden |
| `<Station>.health.heartbeatAlive` | Heartbeat ist innerhalb des erlaubten Zeitfensters aktuell |
| `<Station>.health.meterFresh` | Mindestens ein gültiger numerischer `MeterValues`-Messwert ist aktuell |
| `<Station>.health.powerFresh` | Der für EOS maßgebliche Wert `Power_Active_Import` ist aktuell |
| `<Station>.health.currentFresh` | Ein tatsächlicher Import-/Exportstrom ist aktuell |
| `<Station>.health.socFresh` | Der Fahrzeug-SoC ist innerhalb seines eigenen Zeitfensters aktuell |
| `<Station>.health.safeZeroApplied` | Ein Ladeende-/Leerlaufereignis erlaubt einen sicheren Istwert `0` |
| `<Station>.health.dataFresh` | EOS darf die Bezugsleistung verwenden: `online && (powerFresh || safeZeroApplied)` |
| `<Station>.health.staleReason` | Grund für nicht aktuelle Daten, z. B. `power-values-stale` |
| `<Station>.health.powerAgeSec` | Alter der letzten gültigen Bezugs-Wirkleistung |
| `<Station>.meterValues.Power_Active_Import` | Bezugsleistung der Station in W |
| `<Station>.meterValues.Current_Import` | Gesamtstrom in A; wird bei reinen Phasenwerten summiert |
| `<Station>.meterValues.SoC` | Fahrzeug-SoC, sofern von der Station bzw. dem Fahrzeug gemeldet |
| `<Station>.transactions.transactionActive` | Aktive Transaktion |
| `<Station>.transactions.chargingState` | OCPP-2.x-Ladezustand |

**Verbindliche EOS-Freigabebedingung für die Leistungsregelung:** `health.online === true` **und** `health.dataFresh === true`. Für den SoC gilt zusätzlich separat `health.socFresh === true`. Der reine Heartbeat oder der Zeitstempel eines anderen Messwerts darf nie als Qualitätsnachweis für `powerW` verwendet werden.

## Verbindung der Ladestation

Die Station verbindet sich mit:

```text
ws://<EOS-IP>:9220/<Ladestations-Identität>
```

Beispiel:

```text
ws://192.168.1.50:9220/DC_CHARGER_01
```

Identitäten mit Punkten, Leerzeichen oder Sonderzeichen werden für ioBroker-Objektpfade deterministisch bereinigt. Die ursprüngliche Identität bleibt unter `<Station>.info.identity` erhalten.

## Konfiguration

| Einstellung | Standard | Zweck |
|---|---:|---|
| WebSocket-Port | `9220` | OCPP-Endpunkt |
| Heartbeat-Intervall | `300 s` | Vorgabe in der BootNotification-Antwort |
| Zustandsprüfung | `5 s` | Takt des Aktualitätswächters |
| DP-Neuveröffentlichung | `10 s` | Erneuert unveränderte, weiterhin gültige Daten |
| Maximales Messwertalter | `90 s` | Danach werden `powerFresh` und – ohne sicheren Nullwert – `dataFresh` auf `false` gesetzt |
| Aktive Aktualisierung | an | Fordert neue Telemetrie über `TriggerMessage` an |
| Aktives Aktualisierungsintervall | `15 s` | Mindestabstand zwischen aktiven Anfragen |
| Sicheres Nullsetzen | an | Setzt Ist-Leistung/Strom nur bei eindeutigem Ladeende/Leerlauf auf `0` |
| OCPP-Befehls-Timeout | `20 s` | Abbruchzeit für ausgehende Befehle |

## OCPP-Daten und Steuerung

### Messwerte

Alle numerischen `MeterValues` werden je EVSE/Connector abgelegt. Wichtige Measurands werden zusätzlich nach `<Station>.meterValues.*` gespiegelt. Energie in Wh erhält automatisch einen kWh-Spiegelwert. Phasenwerte werden über mehrere Telegramme hinweg zu Gesamtleistung und Gesamtstrom zusammengeführt, solange sie innerhalb des zulässigen Aktualitätsfensters liegen. SampledValues ohne explizites Measurand/Unit werden bei OCPP 1.6, 2.0.1 und 2.1 protokollkonform als Energie-Importregister in Wh behandelt.

### SoC

Der SoC wird aus mehreren zulässigen Quellen übernommen:

- `MeterValues` mit Measurand `SoC`
- OCPP 2.x `NotifyEVChargingNeeds`
- Device Model `ConnectedEV.StateOfCharge` aus `NotifyReport`

Ein SoC kann nur angezeigt werden, wenn Ladestation und Fahrzeug ihn tatsächlich über OCPP bereitstellen.

### Steuerung

Unter `<Station>.control` stehen unter anderem bereit:

- Verfügbarkeit umschalten
- Hard-/Soft-Reset beziehungsweise Immediate/OnIdle
- Ladegrenze in W oder A setzen
- **Anzahl der Phasen schreibbar vorgeben**
- Remote-/RequestStartTransaction
- Remote-/RequestStopTransaction
- OCPP-2.x-Device-Model-Werte über `SetVariables` schreiben
- generische OCPP-RPC-Aufrufe für Diagnose und Feldtests

Jeder ausgehende Befehl erhält ein Audit unter `control.lastCommand`, `control.lastResponse`, `control.lastError` und `control.lastSuccess`. Abgelehnte Stationsantworten werden nicht als Erfolg behandelt.

## Aliase

Es werden zwei Aliasbäume erzeugt:

```text
alias.0.nexowatt.ocpp.<Instanz>.<Station>.*
alias.0.ocpp21.<Instanz>.<Station>.*
```

Der erste Baum ist die bevorzugte NexoWatt-EOS-Struktur. Der zweite bleibt für bestehende Installationen kompatibel. Enthalten sind unter anderem `powerW`, `currentTotalA`, `soc`, `energyKWh`, Phasenwerte, RFID, Transaktionsdaten und die neuen Aktualitätszustände.

## Vollständige OCPP-Nutzdaten

Jede eingehende und ausgehende OCPP-Nachricht wird unter

```text
<Station>.ocpp.<Protokoll>.<Richtung>.<Action>
```

mit vollständigem JSON (`raw`), Zeitstempel, Zähler und dynamischen Blatt-Datenpunkten gespeichert. Zum Schutz der Objekt-Datenbank ist die dynamische Aufteilung auf zehn Ebenen und 50 Array-Einträge je Ebene begrenzt; der vollständige JSON-Inhalt bleibt in `raw` erhalten.

## Sicherheits- und Funktionsgrenzen

- Der Adapter bildet die für EOS relevanten Lade-, Mess-, Status-, Transaktions-, RFID-, Device-Model- und Smart-Charging-Flows ab und erfasst alle übrigen Nachrichten generisch.
- Nicht explizit implementierte Aktionen werden fehlersicher beantwortet; der Adapter behauptet nicht mehr automatisch, eine unbekannte Funktion erfolgreich ausgeführt zu haben.
- Zertifikats-/PKI-Workflows für OCPP Security Profile 2/3 sind ohne eingerichtetes PKI-Backend nicht aktiv und werden explizit abgelehnt.
- Eine formale OCA-Zertifizierung oder Interoperabilitätsfreigabe mit jedem Stationsmodell wird durch die Softwareprüfung nicht ersetzt. Für neue Hersteller ist ein Feldtest mit realer Firmware weiterhin erforderlich.

## Entwicklung und Tests

```bash
npm install
npm run test:core
npm test
```

`test:core` prüft unter anderem die per-DP-Aktualität, faire Rotation großer DP-/Connector-Mengen, EOS-Freigabelogik, sichere Nullzustände, strikte Device-Model-Typen, OCPP-Payloads, SampledValue-Standardwerte aller drei Versionen, phasenübergreifende Aggregation, Wh→kWh, unveränderte Frischschreibungen und die Registrierung der kritischen Handler.
