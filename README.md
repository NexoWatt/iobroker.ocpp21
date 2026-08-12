# NexoWatt OCPP

**NexoWatt OCPP** is the OCPP central system (CSMS) for the **NexoWatt Energy Operation System (EOS)**. It connects AC and DC charging stations through **OCPP 1.6J, OCPP 2.0.1 and OCPP 2.1** and exposes telemetry, status, transactions, RFID data, SoC, smart-charging controls and complete OCPP payloads as datapoints.

> The visible product name is **NexoWatt OCPP**. The technical adapter ID intentionally remains `ocpp21` to preserve existing instances, object paths, installation scripts and EOS mappings.

## Freshness model

Many charging stations only send `MeterValues` or `StatusNotification` when a value changes. A heartbeat only proves application-level reachability; it does not prove that an old power value is still valid. NexoWatt OCPP therefore separates **connection health**, **heartbeat health** and **meter-data freshness**:

1. Every real OCPP message performs a fresh state write, even when the value is unchanged.
2. While the station is online, cached metadata, status, transaction and counter states are periodically republished. Large state sets rotate fairly across cycles, so datapoints beyond a per-cycle limit are not permanently starved.
3. The adapter actively requests `MeterValues` and `StatusNotification` through `TriggerMessage` when supported. Unsupported or rejected calls are automatically backed off. Slow responses do not block the health watchdog for other stations, and OCPP command timeouts are correctly bounded to 5–120 seconds.
4. Realtime values are evaluated per datapoint. A new current or reactive-power sample can never refresh an old active-import power value. `health.dataFresh` is true only for fresh `Power.Active.Import` telemetry or a protocol-derived safe zero.
5. Measured power/current are set to zero only after a protocol state definitively indicates no energy transfer, such as an ended transaction or an idle/available state.

## EOS-relevant datapoints

| Datapoint | Meaning |
|---|---|
| `<station>.health.online` | OCPP application is active inside the configured heartbeat/activity window |
| `<station>.health.socketConnected` | WebSocket is technically connected |
| `<station>.health.heartbeatAlive` | Heartbeat is within its permitted age |
| `<station>.health.meterFresh` | At least one valid numeric `MeterValues` sample is fresh |
| `<station>.health.powerFresh` | Canonical active-import power is fresh |
| `<station>.health.currentFresh` | Actual import/export current is fresh |
| `<station>.health.socFresh` | EV SoC is fresh inside its independent age window |
| `<station>.health.dataFresh` | Telemetry is sufficiently fresh for the current operating state |
| `<station>.health.staleReason` | Reason for stale data, for example `power-values-stale` |
| `<station>.health.meterAgeSec` | Age of the latest valid meter message |
| `<station>.meterValues.Power_Active_Import` | Station import power in W |
| `<station>.meterValues.Current_Import` | Total current in A, derived from phases when necessary |
| `<station>.meterValues.SoC` | EV state of charge when reported |
| `<station>.transactions.transactionActive` | Active transaction flag |

**Required EOS power-control gate:** require both `health.online === true` and `health.dataFresh === true`. SoC consumers must additionally require `health.socFresh === true`.

## Charging-station endpoint

```text
ws://<EOS-IP>:9220/<charging-station-identity>
```

Identities containing dots, spaces or special characters are converted into deterministic ioBroker-safe object IDs. The original identity remains available in `<station>.info.identity`.

## Main settings

| Setting | Default | Purpose |
|---|---:|---|
| WebSocket port | `9220` | OCPP endpoint |
| Requested heartbeat interval | `300 s` | Returned by BootNotification |
| Health check interval | `5 s` | Freshness watchdog cycle |
| State republish interval | `10 s` | Refreshes unchanged but still valid states |
| Maximum telemetry age | `90 s` | `powerFresh` becomes false; without safe zero, `dataFresh` becomes false as well |
| Active refresh | enabled | Uses `TriggerMessage` when supported |
| Active refresh interval | `15 s` | Minimum interval between active requests |
| Safe zero | enabled | Zeroes measured flow only after definite idle/end states |
| Call timeout | `20 s` | Timeout for outgoing OCPP commands |

## Telemetry and SoC

All numeric sampled values are stored per EVSE/connector. Important measurands are mirrored to `<station>.meterValues.*`. Wh values receive kWh mirrors. Per-phase power and current are accumulated across messages while the phase samples remain within the configured freshness window. Omitted SampledValue measurand/unit fields use the protocol defaults `Energy.Active.Import.Register` and `Wh` for OCPP 1.6, 2.0.1 and 2.1.

SoC can be supplied by:

- `MeterValues` measurand `SoC`
- OCPP 2.x `NotifyEVChargingNeeds`
- Device Model `ConnectedEV.StateOfCharge` through `NotifyReport`

A charging station can only expose SoC when both station and vehicle provide it through OCPP.

## Control

The `<station>.control` tree provides availability switching, reset, charging limits in W/A, writable phase count, remote/request start and stop, OCPP 2.x `SetVariables` write-back, and a generic RPC interface. Every outgoing command is audited through `control.lastCommand`, `control.lastResponse`, `control.lastError` and `control.lastSuccess`. Rejected station responses are treated as failures.

## Aliases

Preferred EOS aliases:

```text
alias.0.nexowatt.ocpp.<instance>.<station>.*
```

Compatibility aliases remain under:

```text
alias.0.ocpp21.<instance>.<station>.*
```

They include power, total current, SoC, energy in kWh, per-phase values, RFID, transactions and freshness states.

## Complete payload capture

Every inbound and outbound OCPP call is stored under:

```text
<station>.ocpp.<protocol>.<direction>.<action>
```

The complete JSON is retained in `raw`, together with a timestamp, message count and dynamic leaf datapoints. Dynamic flattening is limited to ten levels and 50 entries per array to protect the object database; `raw` still contains the complete payload.

## Boundaries

- EOS-relevant telemetry, status, transaction, RFID, Device Model and smart-charging flows are implemented explicitly; every other message is still captured generically.
- Unimplemented actions fail closed rather than being falsely reported as accepted.
- OCPP Security Profile 2/3 certificate workflows require a separate PKI backend and are explicitly rejected without one.
- This software review does not replace formal OCA certification or model-specific interoperability testing with real charger firmware.

## Development

```bash
npm install
npm run test:core
npm test
```

`test:core` covers per-datapoint freshness, fair state/connector rotation, EOS gating, safe zero handling, strict Device Model parsing, all-version SampledValue defaults, phase aggregation, Wh-to-kWh mirrors, fresh writes for unchanged values and critical handler registration for all supported OCPP versions.
