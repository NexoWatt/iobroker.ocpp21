'use strict';

const {
  createAutoResponder,
  getAllRequestActions,
  applyMeterValues,
  extractEnergyImportRegisterWh,
  findVinInPayload,
} = require('./common');

function registerHandlers(client, ctx) {
  const id = client.identity;
  const protocol = 'ocpp2.1';
  const auto = createAutoResponder(protocol);
  const all = getAllRequestActions(protocol);
  const handled = new Set();
  const handle = (method, fn) => {
    handled.add(method);
    client.handle(method, fn);
  };

  // --- Core / commonly used requests from Charging Station -> CSMS ---

  handle('BootNotification', ({ params }) => {
    const p = params || {};
    const cs = p.chargingStation || {};
    const modem = cs.modem || {};
    const interval = (ctx.config.heartbeatIntervalSec || 300) | 0;

    ctx.states
      .upsertIdentityMeta(id, {
        protocol,
        vendor: cs.vendorName,
        model: cs.model,
        firmwareVersion: cs.firmwareVersion,
        serialNumber: cs.serialNumber,
        iccid: modem.iccid,
        imsi: modem.imsi,
      })
      .catch(() => undefined);

    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.heartbeatInterval`, interval, true).catch(() => undefined);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });

  handle('Heartbeat', () => {
    const now = new Date().toISOString();
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.lastHeartbeat`, now, true).catch(() => undefined);
    return { currentTime: now };
  });

  handle('Authorize', () => ({ idTokenInfo: { status: 'Accepted' } }));

  handle('StatusNotification', async ({ params }) => {
    const p = params || {};
    const evseId = Number(p.evseId || 1);
    const connectorId = Number(p.connectorId || 1);
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: p.connectorStatus,
      timestamp: p.timestamp || new Date().toISOString(),
    });
    return {};
  });

  handle('MeterValues', async ({ params }) => {
    const p = params || {};
    const evseId = Number(p.evseId || 1);
    const connectorId = Number(p.connectorId || 1);
    await applyMeterValues(ctx, id, evseId, connectorId, p.meterValue, protocol);
    return {};
  });

  handle('TransactionEvent', async ({ params }) => {
    const p = params || {};
    const evseId = Number((p.evse && p.evse.id) || 1);
    const connectorId = Number((p.evse && p.evse.connectorId) || 1);
    const txId = (p.transactionInfo && p.transactionInfo.transactionId) || undefined;
    const idTag = (p.idToken && p.idToken.idToken) || undefined;
    const ts = p.timestamp || new Date().toISOString();

    if (Array.isArray(p.meterValue)) {
      await applyMeterValues(ctx, id, evseId, connectorId, p.meterValue, protocol);
    }

    // Number of phases (if reported explicitly)
    if (ctx.setStateChangedAsync && typeof p.numberOfPhasesUsed === 'number') {
      await ctx.setStateChangedAsync(`${id}.transactions.numberPhases`, p.numberOfPhasesUsed, true);
    }

    const wh = extractEnergyImportRegisterWh(p.meterValue, protocol);

    if (p.eventType === 'Started') {
      await ctx.states.pushTransactionEvent(id, {
        type: 'Start',
        txId,
        connectorId,
        idTag,
        meterStart: wh,
        ts,
      });
    } else if (p.eventType === 'Ended') {
      await ctx.states.pushTransactionEvent(id, {
        type: 'Stop',
        txId,
        connectorId,
        idTag,
        meterStop: wh,
        reason: (p.transactionInfo && p.transactionInfo.stoppedReason) || p.triggerReason,
        ts,
      });
    }

    return { idTokenInfo: { status: 'Accepted' } };
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

  // --- Security / certificate flows ---
  handle('SignCertificate', () => ({ status: 'Rejected' }));
  handle('Get15118EVCertificate', () => ({ status: 'Failed', exiResponse: '' }));
  handle('GetCertificateStatus', () => ({ status: 'Failed' }));
  handle('InstallCertificate', () => ({ status: 'Rejected' }));
  handle('CertificateSigned', () => ({ status: 'Rejected' }));

  // --- Catch-all: respond with schema-valid minimal payloads ---
  for (const method of all) {
    if (handled.has(method)) continue;
    handle(method, () => auto(method));
  }
}

module.exports = { registerHandlers };
