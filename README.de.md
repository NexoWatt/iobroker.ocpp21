> 🇬🇧 For the English documentation see **README.md**.

# ioBroker Adapter: **ocpp21** ⚡️

Dieser Adapter stellt einen **OCPP WebSocket-Server** bereit (CSMS-Rolle) und kann sich mit Ladestationen verbinden, die **OCPP ab Version 1.6J** sprechen.

✅ Unterstützte Protokolle (parallel aktivierbar):

- **OCPP 1.6J** (`ocpp1.6`)
- **OCPP 2.0.1** (`ocpp2.0.1`)
- **OCPP 2.1** (`ocpp2.1`)

> Hinweis: Der Adapter läuft mit **strictMode deaktiviert**, damit neue/erweiterte Nachrichten nicht abgewiesen werden.
> Antworten werden trotzdem als **schema-minimale, gültige Payloads** erzeugt (basierend auf den offiziellen OCPP 2.0.1/2.1 JSON-Schemas).

---

## Admin-Konfiguration 🛠️

| Option | Beschreibung |
|---|---|
| `port` | WebSocket-Port des OCPP Servers |
| `enable16` | OCPP 1.6J aktivieren |
| `enable201` | OCPP 2.0.1 aktivieren |
| `enable21` | OCPP 2.1 aktivieren |
| `heartbeatIntervalSec` | Heartbeat-Intervall, das im BootNotification-Response zurückgegeben wird |
| `identityAllowlist` | Optional: Liste erlaubter ChargePoint Identities (Whitelist) |

---

## Objektstruktur (Kurzüberblick) 🧭

Pro Ladestation wird ein Geräte-Root unter der **Identity** angelegt:

- `<identity>.info.*`  
  Meta/Status (Vendor, Model, Firmware, Verbindung, Heartbeat, VIN-Feld etc.)
- `<identity>.evse.<evseId>.connector.<connectorId>.*`  
  Connector Status + Messwerte je Connector
- `<identity>.meterValues.*`  
  Aggregierte/gespiegelte Messwerte (z. B. Power, Energy, SoC)
- `<identity>.transactions.*`  
  Transaktionsstatus und letztes Transaktions-Event

Zusätzlich werden angelegt:

- `<identity>.ocpp.<protocol>.(in|out).<Action>.*`  
  Vollständige Payload-Erfassung (raw JSON + flach gemappte Leaf-Datenpunkte)
- `<identity>.dm.*`  
  Device-Model-Datenpunkte (aus `NotifyReport`)

Und für schnelleres Scripten:

- `alias.0.ocpp21.<instance>.<identity>.*`  
  Aliases für die wichtigsten Datenpunkte (connected, status, soc, powerW, energyWh, txActive, chargeLimit, numberPhases, ...)

---

## Controls ✅

### Verfügbarkeit (ChangeAvailability)
- `<identity>.control.availability` (`true/false`)

Mapping:
- OCPP 1.6: `ChangeAvailability { connectorId: 0, type: Operative/Inoperative }`
- OCPP 2.x: `ChangeAvailability { operationalStatus: Operative/Inoperative }`

---

### Reset
- `<identity>.control.hardReset.trigger`
- `<identity>.control.softReset.trigger`

Mapping:
- OCPP 1.6: `Reset { type: Hard/Soft }`
- OCPP 2.x: `Reset { type: Immediate/OnIdle }`

---

### Charge Limit (SetChargingProfile)
- `<identity>.control.chargeLimit` (Zahl)
- `<identity>.control.chargeLimitType` (`W` oder `A`)
- `<identity>.control.numberOfPhases` (1..3) ✅ schreibbar

Mapping:
- OCPP 1.6: `SetChargingProfile` mit `TxDefaultProfile`
- OCPP 2.x: `SetChargingProfile` mit `ChargingStationMaxProfile`

> ℹ️ `numberOfPhases` wird im `chargingSchedulePeriod` gesendet.

---

## Remote Start/Stop (komfortabel) 🚗🔌

Diese Controls sind als „Convenience Wrapper“ gedacht:

- Für **OCPP 2.x** senden sie:
  - `RequestStartTransaction`
  - `RequestStopTransaction`
- Für **OCPP 1.6** werden sie kompatibel gemappt auf:
  - `RemoteStartTransaction`
  - `RemoteStopTransaction`

### Start anfordern

States:

- `<identity>.control.requestStartTransaction.idToken`  
  (bei 1.6 entspricht das `idTag`)
- `<identity>.control.requestStartTransaction.idTokenType` (nur 2.x; Default `Central`)
- `<identity>.control.requestStartTransaction.evseId` (2.x: `evseId`, 1.6: `connectorId`)
- `<identity>.control.requestStartTransaction.remoteStartId` (nur 2.x; wird bei 0/leer automatisch generiert)
- `<identity>.control.requestStartTransaction.chargingProfile` (optional; JSON String, nur 2.x)
- `<identity>.control.requestStartTransaction.trigger` (Button)
- `<identity>.control.requestStartTransaction.lastResponse`
- `<identity>.control.requestStartTransaction.lastError`

---

### Stop anfordern

States:

- `<identity>.control.requestStopTransaction.transactionId`  
  Optional: wenn leer, wird versucht `<identity>.transactions.last.id` zu verwenden.
- `<identity>.control.requestStopTransaction.trigger` (Button)
- `<identity>.control.requestStopTransaction.lastResponse`
- `<identity>.control.requestStopTransaction.lastError`

---

## Generic RPC (für *alle* OCPP Actions) 🧩

Wenn du eine Action ausführen willst, die keinen eigenen Control-State hat:

- `<identity>.control.rpc.method`  (z. B. `GetVariables`)
- `<identity>.control.rpc.payload` (JSON als String)
- `<identity>.control.rpc.execute` (Button)
- `<identity>.control.rpc.lastResponse`
- `<identity>.control.rpc.lastError`

### Beispiel (OCPP 2.x) – GetVariables

**method**:
```text
GetVariables
```

**payload**:
```json
{
  "getVariableData": [
    {
      "component": { "name": "DeviceDataCtrlr" },
      "variable": { "name": "ItemsPerMessageGetVariables" }
    }
  ]
}
```

---

## VIN (Fahrgestellnummer) – geht das? 🧠

- **OCPP standardisiert keine VIN** (1.6/2.0.1/2.1).
- Manche Hersteller schicken sie aber vendor-spezifisch über **DataTransfer** (oder `customData`).

Der Adapter versucht daher rekursiv in `DataTransfer.data` nach:
- einem Feld `vin`
- oder einer 17-stelligen VIN-ähnlichen Zeichenfolge

und schreibt das Ergebnis nach:
- `<identity>.info.vin`

---

## Troubleshooting 🔍

- Wenn ein Call fehlschlägt, schau zuerst in:
  - `<identity>.control.*.lastError`
  - sowie in das ioBroker Log (Adapter-Instanz)

