# NexoWatt OCPP – Zuverlässigkeitsprüfung

Prüfdatum: **2026-08-12**  
Zielversion: **0.3.0**

## Prüfumfang

Geprüft und überarbeitet wurden die Geräteanbindung, OCPP-1.6J-/2.0.1-/2.1-Nachrichtenpfade, Messwertverarbeitung, Heartbeat-/Socket-Überwachung, Datenpunktaktualität für das NexoWatt-EOS-Lademanagement, Ladeende/Nullleistung, Phasenaggregation, SoC, Device Model, Smart-Charging-Befehle, Wiederanlaufverhalten sowie die Kompatibilität vorhandener `ocpp21`-Instanzen.

## Wichtigste Feststellungen und Korrekturen

| Bereich | Vorheriges Risiko | Umgesetzte Korrektur |
|---|---|---|
| Unveränderte Werte | `setStateChangedAsync` ließ den Zeitstempel bei gleichem Wert unverändert | Jede tatsächlich empfangene OCPP-Telemetrie wird mit einem frischen State-Schreibvorgang gespeichert |
| Heartbeat vs. Leistung | Ein aktueller Heartbeat konnte eine Station gesund erscheinen lassen, obwohl `powerW` alt blieb | Getrennte Zustände für Socket, Online-Aktivität, Heartbeat, allgemeine Messwerte, Wirkleistung, Strom, SoC, sicheren Nullwert und EOS-Freigabe |
| Per-DP-Aktualität | Ein neuer Stromwert konnte indirekt einen alten Leistungswert erneut veröffentlichen | Jeder Echtzeit-Datenpunkt trägt seinen eigenen Empfangszeitpunkt; nur genau dieser Datenpunkt darf innerhalb seines Altersfensters erneut veröffentlicht werden |
| Zykluslimits | Bei mehr Datenpunkten/Anschlüssen als dem Zykluslimit hätten immer nur die zuerst angelegten Einträge aktualisiert werden können | DP-Neuveröffentlichung und aktive Connector-Abfragen rotieren fair über den vollständigen Bestand |
| EOS-Freigabe | Beliebige Strom-/Blindleistungswerte konnten als ausreichende Telemetrie gelten | `health.dataFresh = online && (powerFresh || safeZeroApplied)`; `powerFresh` bezieht sich auf `Power.Active.Import` |
| Aktiver Abruf | Eventbasierte Stationen wurden nicht aktiv nach neuen Daten gefragt | Optionaler `TriggerMessage`-Abruf für `MeterValues` und `StatusNotification` mit Erkennung, Fehlerstatus und Backoff |
| Langsame Stationen | Ein fehlerhaft skaliertes Befehls-Timeout bzw. blockierende Refresh-Aufrufe konnten Reaktionszeiten stark verlängern | Sekunden werden korrekt in Millisekunden umgerechnet, auf 5–120 s begrenzt und aktive Refreshes blockieren den Health-Watchdog anderer Stationen nicht |
| Veraltete Leistung nach Ladeende | Eine ausgefallene Schlussmeldung konnte >0 W stehen lassen | Sicheres Nullsetzen bei eindeutigem Ladeende/Leerlauf; während möglicherweise aktiver Ladung wird weder künstlich aktualisiert noch blind auf 0 gesetzt |
| Safe-Zero-Cache | Ein alter abgeleiteter Nullwert hätte nach erneutem Ladebeginn weiter veröffentlicht werden können | Safe-Zero-Datenpunkte werden nur erneut veröffentlicht, solange der Safe-Zero-Zustand noch aktiv ist |
| Neustart | Nach einem unsauberen Adapterende konnten gespeicherte Online-/Fresh-Flags wahr bleiben | Beim Start werden vorhandene Stationen auf „offline / awaiting station“ zurückgesetzt; beim Stop erfolgt ein Best-Effort-Reset |
| Neue OCPP-Sitzung | Alte Cache-/Phasenwerte konnten in eine neue Verbindung hineinreichen | Realtime- und Phasen-Caches werden bei jeder neuen Stationssitzung verworfen |
| Leere/fehlerhafte MeterValues | Unbrauchbare Nachrichten konnten Aktualität vortäuschen | Nur gültige numerische Samples aktualisieren `meterFresh`; aktive Bezugsleistung, Exportleistung, Strom und SoC besitzen getrennte Aktualitätsnachweise |
| Phasenwerte | `powerW`/Gesamtstrom konnten leer bleiben, wenn nur L1/L2/L3 einzeln gemeldet wurden | Frische, phasenbezogene Werte werden zu Gesamtleistung und Gesamtstrom zusammengeführt |
| SampledValue-Defaults | SampledValues ohne `measurand`/`unit` wurden nicht in allen Versionen korrekt eingeordnet | Für OCPP 1.6, 2.0.1 und 2.1 wird der Protokollstandard `Energy.Active.Import.Register` in Wh übernommen |
| OCPP 1.6 Transaktionen | Abschließende `transactionData` fehlten; parallele Anschlüsse konnten beim Stop dem zuletzt gestarteten Anschluss zugeordnet werden | Schlusswerte werden eingelesen und jede aktive Transaktions-ID bleibt bis zum Stop ihrem ursprünglichen Connector zugeordnet |
| OCPP 2.x TransactionEvent | Updates und Ladezustandsdetails waren unvollständig | Started/Updated/Ended, chargingState, triggerReason, seqNo und Messwerte werden verarbeitet |
| SoC | SoC konnte je nach Hersteller in unterschiedlichen OCPP-Pfaden liegen | SoC aus MeterValues, NotifyEVChargingNeeds und `ConnectedEV.StateOfCharge` wird vereinheitlicht; eigenes `socFresh`-Fenster |
| Device Model | Ungültige Boolean-/Integer-/Decimal-Werte konnten stillschweigend umgedeutet werden; Konstanten konnten schreibbar erscheinen | Strikte Typprüfung; konstante bzw. ReadOnly-Attribute sind nicht schreibbar; vorhandene Objektmetadaten werden repariert |
| Geräteidentität/Duplikate | Sonderzeichen oder doppelte Sitzungen konnten Objektpfade bzw. Client-Zuordnung beschädigen | Deterministische kollisionssichere State-ID; Originalidentität bleibt erhalten; neueste Sitzung gewinnt und alte Close-Events entfernen sie nicht |
| Alias-Erstellung | Ein temporärer Fehler konnte einen unvollständigen Aliasbaum dauerhaft als fertig markieren | Fertig-Markierung erst nach vollständiger Erstellung; spätere Strukturaufrufe wiederholen fehlgeschlagene Aliase |
| Generische OCPP-Aktionen | Nicht implementierte Funktionen konnten fälschlich als erfolgreich beantwortet werden | Vollständige Payload-Erfassung; schemaorientierte, fehlersichere Antwort mit Ablehnung/NotImplemented statt Scheinerfolg |
| Ausgehende Befehle | Offline-/Rejected-/Timeout-Fälle waren nicht einheitlich nachvollziehbar | Timeout, Statusprüfung, deterministische Quittierung und Audit-Datenpunkte pro Befehl |

## Verbindliche EOS-Regel

Für die Leistungsregelung gilt:

```text
health.online == true
AND
health.dataFresh == true
```

Dabei ist:

```text
health.dataFresh = health.online
                   AND (health.powerFresh OR health.safeZeroApplied)
```

`health.heartbeatAlive`, `health.meterFresh` oder `health.currentFresh` allein reichen bewusst nicht aus, um einen alten `powerW`-Wert freizugeben. Für SoC-basierte Entscheidungen ist zusätzlich `health.socFresh == true` erforderlich.

## Kompatibilitätsentscheidung

Der sichtbare Name lautet **NexoWatt OCPP**. Technischer Paket- und Adaptername bleiben:

```text
iobroker.ocpp21
ocpp21.0
```

Damit bleiben vorhandene Instanzen, Objektpfade, EOS-Installationsskripte und bestehende Aliasziele erhalten. Ein technischer Rename würde eine neue Namespace-Struktur erzeugen und eine gesonderte Migration erfordern.

## Durchgeführte Prüfungen

Die dependency-freien Core-Tests decken 18 Prüffälle ab, darunter:

- sichere und deterministische Stationsidentitäten
- Heartbeat- und OCPP-Befehls-Timeout-Grenzen
- protokollspezifische TriggerMessage-Payloads
- Safe-Zero-Regeln
- EOS-Freigabelogik
- per-DP-Neuveröffentlichung ohne Fremd-Aktualisierung
- faire Rotation bei begrenzter DP- und Connector-Anzahl je Zyklus
- strikte Device-Model-Typkonvertierung
- frische Schreibvorgänge bei unveränderten Werten
- Phasenaggregation für Leistung und Strom
- Wh→kWh-Spiegelung
- Trennung von Strom/Blindleistung und aktiver Bezugsleistung
- SampledValue-Standardwerte für OCPP 1.6, 2.0.1 und 2.1
- schemaorientierte Fail-Closed-Antworten
- kritische Handler aller drei Protokollversionen, parallele OCPP-1.6-Transaktionen sowie SoC über NotifyEVChargingNeeds

Zusätzlich wurden alle JavaScript-Dateien syntaktisch geprüft, die JSON-Dateien geparst und die OCPP-2.0.1-/2.1-Nachrichten gegen die im Adapter enthaltenen offiziellen JSON-Schemata validiert. Das Ergebnis der Schema-Prüfung:

| Protokoll | automatisch erzeugte Antworten | explizite Antwortvarianten | ausgehende Steuer-/Refresh-Payloads | Fehler |
|---|---:|---:|---:|---:|
| OCPP 2.0.1 | 64 | 17 | 7 | 0 |
| OCPP 2.1 | 90 | 17 | 7 | 0 |

Die dependency-freien Prüfungen und der Paket-Dry-Run wurden vollständig ausgeführt. Die zusätzlichen Tests aus `@iobroker/testing`/Mocha konnten in der isolierten Entwicklungsumgebung nicht installiert und daher nicht ausgeführt werden, weil die npm-Registry während der Prüfung mit dem DNS-Fehler `EAI_AGAIN` nicht erreichbar war. Das ist transparent von einem fehlgeschlagenen Test zu unterscheiden: Die betreffenden Tests wurden nicht gestartet.

## Klare Grenzen

- Eine Ladestation kann nicht gezwungen werden, Messgrößen bereitzustellen, die ihre Firmware nicht unterstützt oder nicht konfiguriert hat. `TriggerMessage` kann nur eine unterstützte Meldung anfordern.
- Bei Mehrfach-Ladestationen sind die EVSE-/Connector-Datenpunkte die verlässlichste Quelle. Ein stationsweiter Gesamtwert ist nur dann ein belastbarer Summenwert, wenn die Station ihn selbst als Gesamtmesswert sendet; der Adapter erfindet keine fehlende Stationssumme aus zeitlich versetzten Connector-Meldungen.
- `health.dataFresh=false` ist deshalb kein Adapterabsturz, sondern eine absichtliche Sperre gegen die Regelung mit alter oder fehlender Bezugsleistung.
- SoC ist nur verfügbar, wenn Fahrzeug und Ladestation ihn über OCPP weiterreichen.
- Zertifikatssignierung und OCPP Security Profile 2/3 benötigen ein separates PKI-/Zertifikatsbackend und werden nicht simuliert.
- TLS/WSS und HTTP-Basic-Authentication sind in dieser Version nicht als eigener Servermodus umgesetzt; der vorgesehene Einsatz ist ein geschütztes EOS-/Anlagennetz.
- Vollständige Payload-Erfassung ist nicht gleichbedeutend mit semantischer Umsetzung jeder optionalen OCPP-Geschäftsfunktion. Nicht implementierte Funktionen werden sichtbar und fehlersicher beantwortet.
- Eine formale OCA-Zertifizierung und modell-/firmwarespezifische Interoperabilitätsprüfung kann nur mit realer Ladestation bzw. einem zertifizierten Testsystem erfolgen.
