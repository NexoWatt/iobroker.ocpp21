'use strict';

const crypto = require('node:crypto');
const { createAutoResponder, applyMeterValues, findVinInPayload } = require('./common');

function map16Connector(connectorId) {
  return { evseId: 1, connectorId: Math.max(0, Number(connectorId) || 0) };
}

function registerHandlers(client, ctx) {
  const id = client.stateIdentity || client.identity;
  const protocol = 'ocpp1.6';
  const auto = createAutoResponder(protocol, { vendorId: 'NexoWatt' });
  const write = async (stateId, value, category = 'status') => {
    if (ctx.setStateFreshAsync) return ctx.setStateFreshAsync(stateId, value, true, category);
    if (ctx.setStateChangedAsync) return ctx.setStateChangedAsync(stateId, value, true);
  };
  const capture = async (method, params) => {
    try {
      if (ctx.dp && typeof ctx.dp.capture === 'function') await ctx.dp.capture(id, protocol, 'in', method, params);
    } catch (e) {
      if (ctx.log && ctx.log.debug) ctx.log.debug(`DP capture failed (${id} ${protocol} ${method}): ${e}`);
    }
  };
  const handle = (method, fn) => {
    client.handle(method, async (msg) => {
      const params = msg && msg.params;
      if (ctx.runtime && typeof ctx.runtime.noteMessage === 'function') await ctx.runtime.noteMessage(id, method);
      await capture(method, params);
      return fn(msg || { params: {} });
    });
  };

  handle('BootNotification', async ({ params }) => {
    const p = params || {};
    const interval = Math.max(10, Number(ctx.config.heartbeatIntervalSec) || 300);
    await ctx.states.upsertIdentityMeta(id, {
      protocol,
      vendor: p.chargePointVendor,
      model: p.chargePointModel,
      firmwareVersion: p.firmwareVersion,
      serialNumber: p.chargePointSerialNumber || p.meterSerialNumber,
      chargePointSerialNumber: p.chargePointSerialNumber,
      chargeBoxSerialNumber: p.chargeBoxSerialNumber,
      iccid: p.iccid,
      imsi: p.imsi,
      meterType: p.meterType,
      meterSerialNumber: p.meterSerialNumber,
    });
    await write(`${id}.info.heartbeatInterval`, interval, 'static');
    if (ctx.runtime && typeof ctx.runtime.noteBoot === 'function') await ctx.runtime.noteBoot(id, interval);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });

  handle('Authorize', async ({ params }) => {
    const idTag = params && params.idTag;
    if (idTag && ctx.states && typeof ctx.states.setRfid === 'function') await ctx.states.setRfid(id, idTag, undefined);
    return { idTagInfo: { status: 'Accepted' } };
  });

  handle('Heartbeat', async () => {
    const now = new Date().toISOString();
    if (ctx.runtime && typeof ctx.runtime.noteHeartbeat === 'function') await ctx.runtime.noteHeartbeat(id, now);
    else await write(`${id}.info.lastHeartbeat`, now, 'health');
    return { currentTime: now };
  });

  handle('StatusNotification', async ({ params }) => {
    const p = params || {};
    const { evseId, connectorId } = map16Connector(p.connectorId);
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: p.status,
      errorCode: p.errorCode,
      info: p.info,
      timestamp: p.timestamp || new Date().toISOString(),
      vendorErrorCode: p.vendorErrorCode,
      vendorId: p.vendorId,
    });
    if (ctx.runtime && typeof ctx.runtime.noteStatus === 'function') await ctx.runtime.noteStatus(id, evseId, connectorId, p.status);
    return {};
  });

  handle('MeterValues', async ({ params }) => {
    const p = params || {};
    const { evseId, connectorId } = map16Connector(p.connectorId);
    await applyMeterValues(ctx, id, evseId, connectorId, p.meterValue, protocol);
    return {};
  });

  handle('StartTransaction', async ({ params }) => {
    const p = params || {};
    if (!(client._transactions instanceof Map)) client._transactions = new Map();
    let txId;
    do {
      txId = crypto.randomInt(1, 0x7fffffff);
    } while (client._transactions.has(String(txId)));
    const meterStart = Number(p.meterStart);
    const connectorId = Math.max(1, Number(p.connectorId) || 1);
    const ts = p.timestamp || new Date().toISOString();

    client._transactions.set(String(txId), {
      connectorId,
      meterStart: Number.isFinite(meterStart) ? meterStart : undefined,
      idTag: p.idTag,
      startedAt: ts,
    });
    // Retain the legacy fallback for non-compliant stations that omit transactionId on stop.
    client._lastConnectorId = connectorId;
    client._lastTransactionId = txId;

    await ctx.states.pushTransactionEvent(id, {
      type: 'Start',
      txId,
      evseId: 1,
      connectorId,
      idTag: p.idTag,
      meterStart: Number.isFinite(meterStart) ? meterStart : undefined,
      chargingState: 'Charging',
      ts,
    });
    if (Number.isFinite(meterStart)) {
      await write(`${id}.evse.1.connector.${connectorId}.meter.lastWh`, meterStart, 'counter');
      await write(`${id}.evse.1.connector.${connectorId}.meter.lastKWh`, meterStart / 1000, 'counter');
    }
    return { transactionId: txId, idTagInfo: { status: 'Accepted' } };
  });

  handle('StopTransaction', async ({ params }) => {
    const p = params || {};
    const txId = p.transactionId ?? client._lastTransactionId;
    const txKey = txId === undefined || txId === null ? undefined : String(txId);
    const txMeta = txKey && client._transactions instanceof Map ? client._transactions.get(txKey) : undefined;
    const connectorId = txMeta && Number.isFinite(Number(txMeta.connectorId))
      ? Math.max(1, Number(txMeta.connectorId))
      : (client._lastConnectorId || 1);
    const ts = p.timestamp || new Date().toISOString();

    // OCPP 1.6 may carry final sampled values in transactionData.
    if (Array.isArray(p.transactionData)) {
      await applyMeterValues(ctx, id, 1, connectorId, p.transactionData, protocol);
    }

    await ctx.states.pushTransactionEvent(id, {
      type: 'Stop',
      txId,
      evseId: 1,
      connectorId,
      idTag: p.idTag || (txMeta && txMeta.idTag),
      meterStop: Number.isFinite(Number(p.meterStop)) ? Number(p.meterStop) : undefined,
      reason: p.reason,
      chargingState: 'Idle',
      ts,
    });
    if (txKey && client._transactions instanceof Map) client._transactions.delete(txKey);
    return { idTagInfo: { status: 'Accepted' } };
  });

  handle('FirmwareStatusNotification', async ({ params }) => {
    await write(`${id}.info.firmwareStatus`, params && params.status, 'status');
    return {};
  });

  handle('DiagnosticsStatusNotification', async ({ params }) => {
    await write(`${id}.info.diagnosticsStatus`, params && params.status, 'status');
    return {};
  });

  handle('DataTransfer', async ({ params }) => {
    const p = params || {};
    const vin = findVinInPayload(p.data);
    if (vin) await write(`${id}.info.vin`, vin, 'static');
    return { status: 'Accepted' };
  });

  // Capture every other message, but fail closed instead of claiming unsupported work was accepted.
  client.handle(async ({ method, params }) => {
    if (ctx.runtime && typeof ctx.runtime.noteMessage === 'function') await ctx.runtime.noteMessage(id, method);
    await capture(method, params);
    return auto(method, { preferFailure: true });
  });
}

module.exports = { registerHandlers, map16Connector };
