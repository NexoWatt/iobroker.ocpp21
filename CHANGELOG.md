# Changelog
## v0.1.2 - 2025-10-26
- OCPP 1.6J: umfassendes Mapping aller gängigen Measurands (Energy/Power/Current/Voltage/Frequency/Temperature/SoC/... inkl. Phase/Location/Context)
- Dynamische State-Anlage pro Measurand (mit Einheit), plus `meter.lastWh/lastTs`
- Info-Felder (BootNotification): vendor, model, firmware, serials (chargePoint*, chargeBox*, meter*), iccid/imsi/meterType
- Heartbeat: `info.lastHeartbeat`, `info.heartbeatInterval`
- StatusNotification: status/error/vendor* je Connector
- Remote-Controls (1.6): RemoteStart/Stop/ChangeAvailability (wie v0.1.1)
