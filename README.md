# ioBroker Adapter: **ocpp21** ⚡️

This adapter provides an **OCPP WebSocket server** (CSMS role) for EV charge points.
It is designed to work with charge points speaking **OCPP 1.6J and newer**.

✅ Supported protocols (can be enabled in parallel):

- **OCPP 1.6J** (`ocpp1.6`)
- **OCPP 2.0.1** (`ocpp2.0.1`)
- **OCPP 2.1** (`ocpp2.1`)

> ℹ️ The server runs with **strictMode disabled** to avoid rejecting newer/extended messages.
> The adapter still answers with **schema-valid minimal responses** (based on official OCPP 2.0.1/2.1 JSON schemas).

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

Additionally, the adapter creates:

- `<identity>.ocpp.<protocol>.(in|out).<Action>.*`  
  Full payload datapoint capture per action (raw JSON + flattened leaf values)
- `<identity>.dm.*`  
  Device Model datapoints (populated via `NotifyReport`)

And for faster scripting:

- `alias.0.ocpp21.<instance>.<identity>.*`  
  Aliases for the most common datapoints (connected, status, protocol, RFID, soc, powerW, energyWh + energyKWh, per-phase V/A/W, txActive, txEnergyKWh, chargeLimit, numberPhases, ...)

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
- `<identity>.control.numberOfPhases` (1..3) ✅ writable

Mapping:
- OCPP 1.6: `SetChargingProfile` with `TxDefaultProfile`
- OCPP 2.x: `SetChargingProfile` with `ChargingStationMaxProfile`

> ℹ️ `numberOfPhases` is sent as part of the (single) `chargingSchedulePeriod`.

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

## Full payload datapoints (no limitations) 📦

Every incoming OCPP request is stored under:

- `<identity>.ocpp.<protocol>.in.<Action>.raw` (full JSON)
- `<identity>.ocpp.<protocol>.in.<Action>.data.*` (flattened leaf values)

> Note: `<protocol>` is sanitized for ioBroker IDs (e.g. `ocpp2_1`, `ocpp2_0_1`, `ocpp1_6`).

This ensures you can access **every field** that the charge point sends — even if it is new in a future edition or vendor-extended.

> The adapter limits deep recursion and very large arrays for stability. The complete payload is always available in `.raw`.

## Device Model datapoints (NotifyReport) 🧩

When the charge point reports variables via `NotifyReport`, the adapter writes them to:

- `<identity>.dm.<Component>.<Variable>.<AttributeType>.value`

If the reported mutability is not `ReadOnly`, the `.value` state is writable and will be written back using `SetVariables`.


## VIN (Vehicle Identification Number) 🧠

OCPP **does not standardize a VIN field** (1.6 / 2.0.1 / 2.1).
Some vendors transmit it vendor-specific via **DataTransfer** (or `customData`).

The adapter therefore tries to detect VIN data in `DataTransfer.data` and writes it to:

- `<identity>.info.vin`

---

## German documentation 🇩🇪

A German version of this README is available in **README.de.md**.
