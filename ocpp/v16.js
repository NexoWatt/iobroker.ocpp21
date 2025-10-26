'use strict';
function baseUnit(value, unit) {
  const map = { 'kWh':['Wh',1000], 'kW':['W',1000], 'Celcius':['°C',1], 'Celsius':['°C',1], 'Fahrenheit':['°F',1] };
  if (map[unit]) return { val: value * map[unit][1], unit: map[unit][0] };
  return { val: value, unit };
}
function normalizeKey(measurand, phase, location, context) {
  const parts = [measurand || 'Reading'];
  if (phase) parts.push(String(phase).replace(/\./g,''));
  if (location && location !== 'Body') parts.push(location);
  if (context && context !== 'Sample.Periodic') parts.push(context);
  return parts.join('_').replace(/[^a-z0-9_.-]+/gi,'_');
}
function map16Connector(connectorId) { return { evseId: 1, connectorId: Number(connectorId || 0) }; }
const AGGREGATES = {
  "Energy.Active.Export.Register": "Energy_Active_Export_Register",
  "Energy.Active.Import.Register": "Energy_Active_Import_Register",
  "Energy.Reactive.Export.Register": "Energy_Reactive_Export_Register",
  "Energy.Reactive.Import.Register": "Energy_Reactive_Import_Register",
  "Energy.Active.Export.Interval": "Energy_Active_Export_Interval",
  "Energy.Active.Import.Interval": "Energy_Active_Import_Interval",
  "Energy.Reactive.Export.Interval": "Energy_Reactive_Export_Interval",
  "Energy.Reactive.Import.Interval": "Energy_Reactive_Import_Interval",
  "Power.Active.Export": "Power_Active_Export",
  "Power.Active.Import": "Power_Active_Import",
  "Power.Offered": "Power_Offered",
  "Current.Import": "Current_Import",
  "Current.Export": "Current_Export",
  "Voltage": "Voltage",
  "Frequency": "Frequency",
  "Temperature": "Temperature",
  "SoC": "SoC"
};

function registerHandlers(client, ctx) {
  const id = client.identity;

  client.handle('BootNotification', ({ params }) => {
    const p = params || {}; const interval = (ctx.config.heartbeatIntervalSec || 300) | 0;
    ctx.states.upsertIdentityMeta(id, {
      protocol: 'ocpp1.6',
      vendor: p.chargePointVendor, model: p.chargePointModel, firmwareVersion: p.firmwareVersion,
      serialNumber: p.chargePointSerialNumber || p.meterSerialNumber,
      chargePointSerialNumber: p.chargePointSerialNumber, chargeBoxSerialNumber: p.chargeBoxSerialNumber,
      iccid: p.iccid, imsi: p.imsi, meterType: p.meterType, meterSerialNumber: p.meterSerialNumber
    }).catch(()=>{});
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.heartbeatInterval`, interval, true);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });

  client.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));

  client.handle('Heartbeat', () => {
    const now = new Date().toISOString();
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.lastHeartbeat`, now, true);
    return { currentTime: now };
  });

  client.handle('StatusNotification', async ({ params }) => {
    const cId = params && params.connectorId; const { evseId, connectorId } = map16Connector(cId);
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: params && params.status, errorCode: params && params.errorCode, info: params && params.info,
      timestamp: (params && params.timestamp) || new Date().toISOString(),
      vendorErrorCode: params && params.vendorErrorCode, vendorId: params && params.vendorId
    });
    return {};
  });

  client.handle('MeterValues', async ({ params }) => {
    const cId = params && params.connectorId; const { evseId, connectorId } = map16Connector(cId);
    const base = `${id}.evse.${evseId}.connector.${connectorId}.meter`;
    const arr = (params && params.meterValue) || [];
    let phasesSeen = new Set();
    if (ctx.setStateChangedAsync) {
      for (const mv of arr) {
        const ts = mv.timestamp || new Date().toISOString();
        await ctx.setStateChangedAsync(`${base}.lastTs`, ts, true);
        const samples = mv.sampledValue || [];
        for (const sv of samples) {
          const rawUnit = sv.unit || '';
          const mult = Number(sv.multiplier || 0);
          const value = parseFloat(sv.value || '0') * Math.pow(10, mult);
          const conv = baseUnit(value, rawUnit);
          const key = normalizeKey(sv.measurand || 'Reading', sv.phase, sv.location, sv.context);
          const idState = await ctx.states.ensureMetricState(id, evseId, connectorId, key, conv.unit || rawUnit || '');
          await ctx.setStateChangedAsync(idState, conv.val, true);

          // Mirror into aggregates (top-level)
          const measKey = String(sv.measurand || '');
          const aggName = AGGREGATES[measKey];
          if (aggName) {
            const aggId = await ctx.states.ensureAggState(id, aggName, conv.unit || rawUnit || '');
            await ctx.setStateChangedAsync(aggId, conv.val, true);
          }
          // Special helpers
          if (String(sv.measurand || '').toLowerCase().includes('energy.active.import.register')) {
            await ctx.setStateChangedAsync(`${base}.lastWh`, conv.val, true);
          }
          if (sv.phase) phasesSeen.add(sv.phase);
          // SoC convenience
          if ((sv.measurand || '') === 'SoC') {
            const socId = await ctx.states.ensureAggState(id, 'SoC', '%');
            await ctx.setStateChangedAsync(socId, conv.val, true);
          }
        }
      }
      // numberPhases heuristic
      let n = 1;
      if ([...phasesSeen].some(p => /L3/.test(p))) n = 3;
      else if ([...phasesSeen].some(p => /L2/.test(p))) n = 2;
      await ctx.setStateChangedAsync(`${id}.transactions.numberPhases`, n, true);
    }
    return {};
  });

  client.handle('StartTransaction', async ({ params }) => {
    const txId = Math.floor(Math.random()*1e9);
    const meterStart = params && params.meterStart; const idTag = params && params.idTag;
    if (ctx.setStateChangedAsync) {
      const base = `${id}.transactions.last`;
      await ctx.setStateChangedAsync(`${base}.type`, 'Start', true);
      await ctx.setStateChangedAsync(`${base}.id`, txId, true);
      await ctx.setStateChangedAsync(`${base}.connectorId`, params && params.connectorId, true);
      await ctx.setStateChangedAsync(`${base}.idTag`, idTag, true);
      await ctx.setStateChangedAsync(`${base}.meterStart`, meterStart, true);
      await ctx.setStateChangedAsync(`${base}.ts`, (params && params.timestamp) || new Date().toISOString(), true);
      await ctx.setStateChangedAsync(`${id}.transactions.idTag`, idTag, true);
      await ctx.setStateChangedAsync(`${id}.transactions.transactionActive`, true, true);
      const { evseId, connectorId } = map16Connector(params && params.connectorId);
      if (typeof meterStart === 'number') await ctx.setStateChangedAsync(`${id}.evse.${evseId}.connector.${connectorId}.meter.lastWh`, meterStart, true);
      if (typeof meterStart === 'number') await ctx.setStateChangedAsync(`${id}.transactions.transactionStartMeter`, meterStart, true);
    }
    return { transactionId: txId, idTagInfo: { status: 'Accepted' } };
  });

  client.handle('StopTransaction', async ({ params }) => {
    const meterStop = params && params.meterStop;
    if (ctx.setStateChangedAsync) {
      const base = `${id}.transactions.last`;
      await ctx.setStateChangedAsync(`${base}.type`, 'Stop', true);
      await ctx.setStateChangedAsync(`${base}.reason`, params && params.reason, true);
      await ctx.setStateChangedAsync(`${base}.meterStop`, meterStop, true);
      await ctx.setStateChangedAsync(`${base}.ts`, (params && params.timestamp) || new Date().toISOString(), true);
      await ctx.setStateChangedAsync(`${id}.transactions.transactionActive`, false, true);
      if (typeof meterStop === 'number') await ctx.setStateChangedAsync(`${id}.transactions.transactionEndMeter`, meterStop, true);
      const startState = await ctx.setStateChangedAsync ? null : null;
    }
    return { idTagInfo: { status: 'Accepted' } };
  });

  client.handle('FirmwareStatusNotification', async ({ params }) => {
    if (ctx.setStateChangedAsync) await ctx.setStateChangedAsync(`${id}.info.firmwareStatus`, params && params.status, true);
    return {};
  });
  client.handle('DiagnosticsStatusNotification', async ({ params }) => {
    if (ctx.setStateChangedAsync) await ctx.setStateChangedAsync(`${id}.info.diagnosticsStatus`, params && params.status, true);
    return {};
  });

  client.handle('DataTransfer', () => ({ status: 'UnknownVendorId' }));
}
module.exports = { registerHandlers };
