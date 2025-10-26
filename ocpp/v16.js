'use strict';
let txCounter = 1;
function nextTxId() { txCounter = (txCounter % 2147480000) + 1; return txCounter; }
function map16Connector(connectorId) { return { evseId: 1, connectorId: Number(connectorId || 0) }; }
function registerHandlers(client, ctx) {
  const id = client.identity;
  client.handle('BootNotification', ({ params }) => {
    const p = params || {}; const interval = (ctx.config.heartbeatIntervalSec || 300) | 0;
    ctx.states.upsertIdentityMeta(id, { protocol: 'ocpp1.6', vendor: p.chargePointVendor, model: p.chargePointModel,
      firmwareVersion: p.firmwareVersion, serialNumber: p.chargePointSerialNumber || p.meterSerialNumber }).catch(()=>{});
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.heartbeatInterval`, interval, true);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });
  client.handle('Authorize', ({ params }) => ({ idTagInfo: { status: 'Accepted' } }));
  client.handle('Heartbeat', () => { const now = new Date().toISOString(); if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.lastHeartbeat`, now, true); return { currentTime: now }; });
  client.handle('StatusNotification', async ({ params }) => {
    const cId = params && params.connectorId; const { evseId, connectorId } = map16Connector(cId);
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: params && params.status, errorCode: params && params.errorCode, info: params && params.info,
      timestamp: (params && params.timestamp) || new Date().toISOString(),
    });
    if (ctx.setStateChangedAsync) {
      const base = `${id}.evse.${evseId}.connector.${connectorId}`;
      if (params && params.vendorErrorCode) await ctx.setStateChangedAsync(`${base}.vendorErrorCode`, params.vendorErrorCode, true);
      if (params && params.vendorId) await ctx.setStateChangedAsync(`${base}.vendorId`, params.vendorId, true);
    }
    return {};
  });
  client.handle('MeterValues', async ({ params }) => {
    const cId = params && params.connectorId; const { evseId, connectorId } = map16Connector(cId);
    const base = `${id}.evse.${evseId}.connector.${connectorId}.meter`;
    const arr = (params && params.meterValue) || [];
    if (ctx.setStateChangedAsync) {
      for (const mv of arr) {
        const ts = mv.timestamp || new Date().toISOString();
        const sv = (mv.sampledValue && mv.sampledValue[0]) || {};
        const unit = sv.unit || 'Wh';
        let valNum = parseFloat(sv.value || '0');
        if (unit === 'kWh') valNum *= 1000;
        await ctx.setStateChangedAsync(`${base}.lastTs`, ts, true);
        await ctx.setStateChangedAsync(`${base}.lastWh`, valNum, true);
        if (sv.measurand) {
          const key = String(sv.measurand).replace(/[^a-z0-9_.-]+/gi,'_');
          await ctx.setStateChangedAsync(`${base}.${key}`, parseFloat(sv.value || '0'), true);
        }
      }
    }
    return {};
  });
  client.handle('StartTransaction', async ({ params }) => {
    const txId = nextTxId();
    if (ctx.setStateChangedAsync) {
      const base = `${id}.transactions.last`;
      await ctx.setStateChangedAsync(`${base}.type`, 'Start', true);
      await ctx.setStateChangedAsync(`${base}.id`, txId, true);
      await ctx.setStateChangedAsync(`${base}.connectorId`, params && params.connectorId, true);
      await ctx.setStateChangedAsync(`${base}.idTag`, params && params.idTag, true);
      await ctx.setStateChangedAsync(`${base}.meterStart`, params && params.meterStart, true);
      await ctx.setStateChangedAsync(`${base}.ts`, (params && params.timestamp) || new Date().toISOString(), true);
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
    }
    return { idTagInfo: { status: 'Accepted' } };
  });
  client.handle('DataTransfer', () => ({ status: 'UnknownVendorId' }));
}
module.exports = { registerHandlers };
