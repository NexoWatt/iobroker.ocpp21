# ioBroker Adapter: **ocpp21** ⚡️

This adapter provides an **OCPP WebSocket server** (CSMS role) for EV charge points.
It is designed to work with charge points speaking **OCPP 1.6J and newer**.

✅ Supported protocols (can be enabled in parallel):

- **OCPP 1.6J** (`ocpp1.6`)
- **OCPP 2.0.1** (`ocpp2.0.1`)
- **OCPP 2.1** (`ocpp2.1`)

> ℹ️ The server runs in **strictMode** (schema validation via `ocpp-rpc`). This helps with standard compliance.

---

## Requirements ✅

- **Node.js >= 18**
- **ioBroker js-controller >= 6** (recommended/declared dependency)

---

## Admin configuration 🛠️

| Option | Description |
|---|---|
| `port` | WebSocket port of the OCPP server |
| `enable16` | Enable OCPP 1.6J |
| `enable201` | Enable OCPP 2.0.1 |
| `enable21` | Enable OCPP 2.1 |
| `heartbeatIntervalSec` | Heartbeat interval returned by `BootNotification.conf/Response` |
| `identityAllowlist` | Optional list of allowed charge point identities (allowlist) |

---

## Object tree (high level) 🧭

For each connected charge point an object root is created under its **identity**:

- `<identity>.info.*`  
  Metadata/status (vendor, model, firmware, connection, heartbeat, VIN field, ...)
- `<identity>.evse.<evseId>.connector.<connectorId>.*`  
  Connector status + meter states per connector
- `<identity>.meterValues.*`  
  Aggregated meter values (e.g. power, energy, SoC)
- `<identity>.transactions.*`  
  Transaction state + last transaction event

---

## Controls ✅

### Availability (ChangeAvailability)
- `<identity>.control.availability` (`true/false`)

Mapping:
- OCPP 1.6: `ChangeAvailability { connectorId: 0, type: Operative/Inoperative }`
- OCPP 2.x: `ChangeAvailability { operationalStatus: Operative/Inoperative }`

### Reset
- `<identity>.control.hardReset.trigger`
- `<identity>.control.softReset.trigger`

Mapping:
- OCPP 1.6: `Reset { type: Hard/Soft }`
- OCPP 2.x: `Reset { type: Immediate/OnIdle }`

### Charge limit (SetChargingProfile)
- `<identity>.control.chargeLimit` (number)
- `<identity>.control.chargeLimitType` (`W` or `A`)

Mapping:
- OCPP 1.6: `SetChargingProfile` with `TxDefaultProfile`
- OCPP 2.x: `SetChargingProfile` with `ChargingStationMaxProfile`

---

## Remote Start/Stop (convenience) 🚗🔌

These controls provide a unified interface:

- For **OCPP 2.x** the adapter sends:
  - `RequestStartTransaction`
  - `RequestStopTransaction`
- For **OCPP 1.6** these are mapped to:
  - `RemoteStartTransaction`
  - `RemoteStopTransaction`

### Request start

- `<identity>.control.requestStartTransaction.idToken`  
  (in 1.6 this is `idTag`)
- `<identity>.control.requestStartTransaction.idTokenType` (2.x only; default `Central`)
- `<identity>.control.requestStartTransaction.evseId` (2.x: `evseId`, 1.6: `connectorId`)
- `<identity>.control.requestStartTransaction.remoteStartId` (2.x only; auto-generated if 0/empty)
- `<identity>.control.requestStartTransaction.chargingProfile` (optional; JSON string, 2.x only)
- `<identity>.control.requestStartTransaction.trigger`
- `<identity>.control.requestStartTransaction.lastResponse`
- `<identity>.control.requestStartTransaction.lastError`

### Request stop

- `<identity>.control.requestStopTransaction.transactionId`  
  Optional: if empty, the adapter tries `<identity>.transactions.last.id`.
- `<identity>.control.requestStopTransaction.trigger`
- `<identity>.control.requestStopTransaction.lastResponse`
- `<identity>.control.requestStopTransaction.lastError`

---

## Generic RPC (any OCPP action) 🧩

If you need an action without a dedicated control state:

- `<identity>.control.rpc.method`  (e.g. `GetVariables`)
- `<identity>.control.rpc.payload` (JSON as string)
- `<identity>.control.rpc.execute`
- `<identity>.control.rpc.lastResponse`
- `<identity>.control.rpc.lastError`

---

## VIN (Vehicle Identification Number) 🧠

OCPP **does not standardize a VIN field** (1.6 / 2.0.1 / 2.1).
Some vendors transmit it vendor-specific via **DataTransfer** (or `customData`).

The adapter therefore tries to detect VIN data in `DataTransfer.data` and writes it to:

- `<identity>.info.vin`

---

## German documentation 🇩🇪

A German version of this README is available in **README.de.md**.
