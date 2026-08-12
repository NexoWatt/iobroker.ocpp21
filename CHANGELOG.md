# Changelog

## 0.3.0 (2026-08-12)

- Rename the visible adapter to **NexoWatt OCPP** while retaining the compatible technical ID `ocpp21`.
- Add EOS freshness watchdog and health datapoints for socket, heartbeat, online state, meter age, data quality and stale reason.
- Refresh unchanged values on every real OCPP message and periodically republish still-valid cached states per datapoint.
- Rotate large datapoint sets and multi-connector refresh requests fairly so entries beyond a per-cycle limit are not starved.
- Add optional active `TriggerMessage` refresh for MeterValues and StatusNotification with support detection and backoff.
- Keep health processing non-blocking during slow active-refresh calls and correctly enforce the configured 5–120 second OCPP command timeout.
- Add safe zeroing on definite idle/ended states without masking stale active charging telemetry.
- Keep a protocol-derived idle zero valid across counter/SoC/zero-only messages and invalidate it only on contradictory non-zero flow or charging activity.
- Improve station identity sanitization, duplicate-session handling, command timeout/auditing and shutdown behavior.
- Aggregate total power and current across phase values arriving in separate messages.
- Process OCPP 1.6 StopTransaction transactionData, preserve transaction-to-connector mappings for concurrent connectors and handle all OCPP 2.x TransactionEvent variants.
- Apply the compact SampledValue defaults (`Energy.Active.Import.Register`, `Wh`) consistently for OCPP 1.6, 2.0.1 and 2.1.
- Track general MeterValues, active-import power, export power, current and SoC freshness independently.
- Reset persisted online/fresh flags and all realtime/session caches on restart or reconnect.
- Fail closed for unsupported generic actions and explicitly reject PKI workflows without a backend.
- Add deterministic core tests, official OCPP 2.x schema checks and a detailed NexoWatt reliability review.

## v0.2.2 - 2026-02-25
- Derive total Power.Active.Import from per-phase values if the station does not provide a total (fixes empty `powerW` alias)
- Add additional phase aliases for current/power with L1N/L2N/L3N phase notation
- Mirror Device Model `ConnectedEV.StateOfCharge` (Actual) into `meterValues.SoC` for stations reporting SoC via Device Model instead of MeterValues

## v0.2.1 - 2026-02-25
- Add RFID capture and aliases (from Authorize + transactions)
- Mirror Wh energy datapoints into kWh helper datapoints for easier UI usage
- Extend alias set (energy in kWh, per-phase V/A/W, transaction energy)
- Add connector and transaction kWh helper states

## v0.2.0 - 2026-02-25
- Add full OCPP payload datapoint capture under `identity.ocpp.<protocol>.(in|out).<Action>.data.*` (raw JSON + flattened leaf DPs)
- Add Device Model datapoints from `NotifyReport` under `identity.dm.*` and support write-back via `SetVariables`
- Add ioBroker aliases for key datapoints under `alias.0.ocpp21.<instance>.<identity>.*`
- Add writable `control.numberOfPhases` and include `numberPhases` in smart-charging `SetChargingProfile`

## v0.1.6 - 2026-02-23
- Repository/review housekeeping: add English README.md + German README.de.md
- Add i18n labels for admin JSON config
- Add io-package translations and js-controller dependency
- Add test scaffold (package/unit/integration) and CI workflow skeleton

## v0.1.5 - 2026-02-23
- Add control wrapper states for RequestStartTransaction / RequestStopTransaction (OCPP 2.x) and map to RemoteStart/RemoteStop for OCPP 1.6
- Add per-control lastResponse/lastError states
- Extend README with configuration and RPC examples

## v0.1.4 - 2025-10-26
- Add SoC & full measurands
- Aggregated states + numberPhases heuristic
