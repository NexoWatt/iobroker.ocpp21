'use strict';

const {
  createAutoResponder,
  applyMeterValues,
  extractEnergyImportRegisterWh,
  findVinInPayload,
} = require('./common');

function registerHandlers(client, ctx) {
  const id = client.identity;
  const protocol = 'ocpp2.0.1';
  const auto = createAutoResponder(protocol);
  const capture = async (method, params) => {
    try {
      if (ctx && ctx.dp && typeof ctx.dp.capture === 'function') {
        await ctx.dp.capture(id, protocol, 'in', method, params);
      }
    } catch (e) {
      // never break protocol flow due to DP issues
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

  handle('Authorize', ({ params }) => {
    const p = params || {};
    const token = p.idToken && p.idToken.idToken;
    const tokenType = p.idToken && p.idToken.type;
    if (token && ctx.states && typeof ctx.states.setRfid === 'function') {
      ctx.states.setRfid(id, token, tokenType).catch(() => undefined);
    }
    return { idTokenInfo: { status: 'Accepted' } };
  });

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
    const idTokenType = (p.idToken && p.idToken.type) || undefined;
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
        idTokenType,
        meterStart: wh,
        ts,
      });
    } else if (p.eventType === 'Ended') {
      await ctx.states.pushTransactionEvent(id, {
        type: 'Stop',
        txId,
        connectorId,
        idTag,
        idTokenType,
        meterStop: wh,
        reason: (p.transactionInfo && p.transactionInfo.stoppedReason) || p.triggerReason,
        ts,
      });
    }

    // Provide positive authorization feedback.
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

  // NotifyEVChargingNeeds can contain the EV state of charge (SoC) via ISO15118 / EV communication.
  // Some stations do not report SoC via MeterValues but do include it here.
  handle('NotifyEVChargingNeeds', async ({ params }) => {
    const p = params || {};
    const soc = p.chargingNeeds && typeof p.chargingNeeds.stateOfCharge === 'number' ? p.chargingNeeds.stateOfCharge : undefined;
    if (soc !== undefined) {
      const socId = await ctx.states.ensureAggState(id, 'SoC', '%');
      await ctx.setStateChangedAsync(socId, soc, true);
    }
    return { status: 'Accepted' };
  });

  // --- Device Model / reporting ---
  handle('NotifyReport', async ({ params }) => {
    try {
      if (ctx && ctx.dm && typeof ctx.dm.ingestNotifyReport === 'function') {
        await ctx.dm.ingestNotifyReport(id, protocol, params || {});
      }
    } catch (e) {
      if (ctx && ctx.log && ctx.log.warn) ctx.log.warn(`NotifyReport ingest failed for ${id}: ${e}`);
    }
    return {};
  });

  // --- Security / certificate flows ---
  // We explicitly fail these by default (instead of responding Accepted),
  // because "Accepted" would require follow-up processing (signing, OCSP, ISO15118 EXI payloads).
  handle('SignCertificate', () => ({ status: 'Rejected' }));
  handle('Get15118EVCertificate', () => ({ status: 'Failed', exiResponse: '' }));
  handle('GetCertificateStatus', () => ({ status: 'Failed' }));
  handle('InstallCertificate', () => ({ status: 'Rejected' }));
  handle('CertificateSigned', () => ({ status: 'Rejected' }));

  // --- Default handler: capture everything + respond schema-valid minimal payloads ---
  client.handle(async ({ method, params }) => {
    await capture(method, params);
    return auto(method);
  });
}

module.exports = { registerHandlers };
