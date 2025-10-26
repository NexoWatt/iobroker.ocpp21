'use strict';
function unitFor(measurand) {
  const m = String(measurand || '').toLowerCase();
  if (m.includes('energy')) return 'Wh';
  if (m.includes('power')) return 'W';
  if (m.includes('current')) return 'A';
  if (m.includes('voltage')) return 'V';
  if (m.includes('frequency')) return 'Hz';
  if (m.includes('temperature')) return '°C';
  if (m.includes('soc')) return '%';
  if (m.includes('rpm')) return '1/min';
  return '';
}
function normalizeKey(measurand, phase, location, context) {
  const parts = [measurand || 'Reading'];
  if (phase) parts.push(phase);
  if (location && location !== 'Body') parts.push(location);
  if (context && context !== 'Sample.Periodic') parts.push(context);
  return parts.join('_').replace(/[^a-z0-9_.-]+/gi,'_');
}
function convertToBase(value, unit) {
  // normalize to smaller base units where reasonable
  if (unit === 'kWh') return { val: value * 1000, unit: 'Wh' };
  if (unit === 'kW') return { val: value * 1000, unit: 'W' };
  return { val: value, unit };
}
function map16Connector(connectorId) { return { evseId: 1, connectorId: Number(connectorId || 0) }; }

function registerHandlers(client, ctx) {
  const id = client.identity;

  client.handle('BootNotification', ({ params }) => {
    const p = params || {}; const interval = (ctx.config.heartbeatIntervalSec || 300) | 0;
    ctx.states.upsertIdentityMeta(id, {
      protocol: 'ocpp1.6',
      vendor: p.chargePointVendor,
      model: p.chargePointModel,
      firmwareVersion: p.firmwareVersion,
      serialNumber: p.chargePointSerialNumber || p.meterSerialNumber,
      chargePointSerialNumber: p.chargePointSerialNumber,
      chargeBoxSerialNumber: p.chargeBoxSerialNumber,
      iccid: p.iccid,
      imsi: p.imsi,
      meterType: p.meterType,
      meterSerialNumber: p.meterSerialNumber
    }).catch(()=>{});
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.heartbeatInterval`, interval, true);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });

  client.handle('Authorize', ({ params }) => ({ idTagInfo: { status: 'Accepted' } }));

  client.handle('Heartbeat', () => {
    const now = new Date().toISOString();
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.lastHeartbeat`, now, true);
    return { currentTime: now };
  });

  client.handle('StatusNotification', async ({ params }) => {
    const cId = params && params.connectorId;
    const { evseId, connectorId } = map16Connector(cId);
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: params && params.status,
      errorCode: params && params.errorCode,
      info: params && params.info,
      timestamp: (params && params.timestamp) || new Date().toISOString(),
      vendorErrorCode: params && params.vendorErrorCode,
      vendorId: params && params.vendorId
    });
    return {};
  });

  client.handle('MeterValues', async ({ params }) => {
    const cId = params && params.connectorId;
    const { evseId, connectorId } = map16Connector(cId);
    const base = `${id}.evse.${evseId}.connector.${connectorId}.meter`;
    const arr = (params && params.meterValue) || [];
    if (ctx.setStateChangedAsync) {
      for (const mv of arr) {
        const ts = mv.timestamp || new Date().toISOString();
        await ctx.setStateChangedAsync(`${base}.lastTs`, ts, true);
        const samples = mv.sampledValue || [];
        for (const sv of samples) {
          const rawUnit = sv.unit || unitFor(sv.measurand);
          const value = parseFloat(sv.value || '0');
          const conv = convertToBase(value, rawUnit);
          const key = normalizeKey(sv.measurand || 'Reading', sv.phase, sv.location, sv.context);
          const idState = await ctx.states.ensureMetricState(id, evseId, connectorId, key, conv.unit || rawUnit || '');
          await ctx.setStateChangedAsync(idState, conv.val, true);
          if ((sv.measurand || '').toLowerCase().includes('energy.active.import.register')) {
            await ctx.setStateChangedAsync(`${base}.lastWh`, conv.val, true);
          }
        }
      }
    }
    return {};
  });

  client.handle('StartTransaction', async ({ params }) => {
    const txId = Math.floor(Math.random()*1e9);
    if (ctx.setStateChangedAsync) {
      const base = `${id}.transactions.last`;
      await ctx.setStateChangedAsync(`${base}.type`, 'Start', true);
      await ctx.setStateChangedAsync(`${base}.id`, txId, true);
      await ctx.setStateChangedAsync(`${base}.connectorId`, params && params.connectorId, true);
      await ctx.setStateChangedAsync(`${base}.idTag`, params && params.idTag, true);
      await ctx.setStateChangedAsync(`${base}.meterStart`, params && params.meterStart, true);
      await ctx.setStateChangedAsync(`${base}.ts`, (params && params.timestamp) || new Date().toISOString(), true);
      // also reflect into meter.lastWh if provided
      const { evseId, connectorId } = map16Connector(params && params.connectorId);
      if (params && typeof params.meterStart === 'number') {
        await ctx.setStateChangedAsync(`${id}.evse.${evseId}.connector.${connectorId}.meter.lastWh`, params.meterStart, true);
      }
    }
    return { transactionId: txId, idTagInfo: { status: 'Accepted' } };
  });

  client.handle('StopTransaction', async ({ params }) => {
    if (ctx.setStateChangedAsync) {
      const base = `${id}.transactions.last`;
      await ctx.setStateChangedAsync(`${base}.type`, 'Stop', true);
      await ctx.setStateChangedAsync(`${base}.reason`, params && params.reason, true);
      await ctx.setStateChangedAsync(`${base}.meterStop`, params && params.meterStop, true);
      await ctx.setStateChangedAsync(`${base}.ts`, (params && params.timestamp) || new Date().toISOString(), true);
      const { evseId, connectorId } = map16Connector( (params && params.transactionData && params.transactionData[0] && params.transactionData[0].sampledValue && params.transactionData[0].sampledValue[0] && params.transactionData[0].sampledValue[0].context) ? 1 : 1 );
      if (params && typeof params.meterStop === 'number') {
        await ctx.setStateChangedAsync(`${id}.evse.${evseId}.connector.${connectorId}.meter.lastWh`, params.meterStop, true);
      }
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
