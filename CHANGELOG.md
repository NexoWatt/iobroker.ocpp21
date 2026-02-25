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
