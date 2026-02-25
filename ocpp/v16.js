'use strict';

const { createAutoResponder, applyMeterValues, findVinInPayload } = require('./common');

function map16Connector(connectorId) {
  return { evseId: 1, connectorId: Number(connectorId || 0) };
}

function registerHandlers(client, ctx) {
  const id = client.identity;
  const protocol = 'ocpp1.6';
  const auto = createAutoResponder(protocol);
  const capture = async (method, params) => {
    try {
      if (ctx && ctx.dp && typeof ctx.dp.capture === 'function') {
        await ctx.dp.capture(id, protocol, 'in', method, params);
      }
    } catch (e) {
      if (ctx && ctx.log && ctx.log.debug) ctx.log.debug(`dp capture failed (${id} ${protocol} ${method}): ${e}`);
    }
  };
  const handle = (method, fn) => {
    client.handle(method, async (msg) => {
      const params = msg && msg.params;
      await capture(method, params);
      return fn(msg);
    });
  };

  handle('BootNotification', ({ params }) => {
    const p = params || {};
    const interval = (ctx.config.heartbeatIntervalSec || 300) | 0;

    ctx.states
      .upsertIdentityMeta(id, {
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
      })
      .catch(() => undefined);

    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.heartbeatInterval`, interval, true).catch(() => undefined);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });

  handle('Authorize', ({ params }) => {
    const p = params || {};
    const idTag = p.idTag;
    if (idTag && ctx.states && typeof ctx.states.setRfid === 'function') {
      ctx.states.setRfid(id, idTag, undefined).catch(() => undefined);
    }
    return { idTagInfo: { status: 'Accepted' } };
  });

  handle('Heartbeat', () => {
    const now = new Date().toISOString();
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.lastHeartbeat`, now, true).catch(() => undefined);
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
    const txId = Math.floor(Math.random() * 1e9);
    const meterStart = p.meterStart;
    const idTag = p.idTag;
    const ts = p.timestamp || new Date().toISOString();

    // Remember last connector to be able to link StopTransaction (which has no connectorId in 1.6)
    client._lastConnectorId = Number(p.connectorId || 1);
    client._lastTransactionId = txId;

    await ctx.states.pushTransactionEvent(id, {
      type: 'Start',
      txId,
      connectorId: Number(p.connectorId || 1),
      idTag,
      meterStart,
      ts,
    });
    // Mirror energy into connector meter as a convenience
    const { evseId, connectorId } = map16Connector(p.connectorId);
    if (typeof meterStart === 'number' && ctx.setStateChangedAsync) {
      await ctx.setStateChangedAsync(`${id}.evse.${evseId}.connector.${connectorId}.meter.lastWh`, meterStart, true);
      await ctx.setStateChangedAsync(`${id}.evse.${evseId}.connector.${connectorId}.meter.lastKWh`, meterStart / 1000, true);
    }

    return { transactionId: txId, idTagInfo: { status: 'Accepted' } };
  });

  handle('StopTransaction', async ({ params }) => {
    const p = params || {};
    const txId = p.transactionId || client._lastTransactionId;
    const connectorId = client._lastConnectorId || 1;
    const ts = p.timestamp || new Date().toISOString();

    await ctx.states.pushTransactionEvent(id, {
      type: 'Stop',
      txId,
      connectorId,
      idTag: p.idTag,
      meterStop: p.meterStop,
      reason: p.reason,
      ts,
    });
    return { idTagInfo: { status: 'Accepted' } };
  });

  handle('FirmwareStatusNotification', async ({ params }) => {
    if (ctx.setStateChangedAsync) await ctx.setStateChangedAsync(`${id}.info.firmwareStatus`, params && params.status, true);
    return {};
  });

  handle('DiagnosticsStatusNotification', async ({ params }) => {
    if (ctx.setStateChangedAsync) await ctx.setStateChangedAsync(`${id}.info.diagnosticsStatus`, params && params.status, true);
    return {};
  });

  handle('DataTransfer', async ({ params }) => {
    const p = params || {};
    const vin = findVinInPayload(p.data);
    if (vin && ctx.setStateChangedAsync) await ctx.setStateChangedAsync(`${id}.info.vin`, vin, true);
    return { status: 'Accepted' };
  });

  // --- Default handler: capture everything + respond schema-valid minimal payloads ---
  client.handle(async ({ method, params }) => {
    await capture(method, params);
    return auto(method);
  });
}

module.exports = { registerHandlers };
