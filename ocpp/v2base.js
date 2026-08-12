'use strict';

const {
  createAutoResponder,
  applyMeterValues,
  extractEnergyImportRegisterWh,
  findVinInPayload,
} = require('./common');

function registerV2Handlers(client, ctx, protocol) {
  const id = client.stateIdentity || client.identity;
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
    const cs = p.chargingStation || {};
    const modem = cs.modem || {};
    const interval = Math.max(10, Number(ctx.config.heartbeatIntervalSec) || 300);
    await ctx.states.upsertIdentityMeta(id, {
      protocol,
      vendor: cs.vendorName,
      model: cs.model,
      firmwareVersion: cs.firmwareVersion,
      serialNumber: cs.serialNumber,
      iccid: modem.iccid,
      imsi: modem.imsi,
    });
    await write(`${id}.info.heartbeatInterval`, interval, 'static');
    if (ctx.runtime && typeof ctx.runtime.noteBoot === 'function') await ctx.runtime.noteBoot(id, interval);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });

  handle('Heartbeat', async () => {
    const now = new Date().toISOString();
    if (ctx.runtime && typeof ctx.runtime.noteHeartbeat === 'function') await ctx.runtime.noteHeartbeat(id, now);
    else await write(`${id}.info.lastHeartbeat`, now, 'health');
    return { currentTime: now };
  });

  handle('Authorize', async ({ params }) => {
    const p = params || {};
    const token = p.idToken && p.idToken.idToken;
    const tokenType = p.idToken && p.idToken.type;
    if (token && ctx.states && typeof ctx.states.setRfid === 'function') await ctx.states.setRfid(id, token, tokenType);
    return { idTokenInfo: { status: 'Accepted' } };
  });

  handle('StatusNotification', async ({ params }) => {
    const p = params || {};
    const evseId = Math.max(0, Number(p.evseId) || 1);
    const connectorId = Math.max(0, Number(p.connectorId) || 1);
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: p.connectorStatus,
      timestamp: p.timestamp || new Date().toISOString(),
    });
    if (ctx.runtime && typeof ctx.runtime.noteStatus === 'function') await ctx.runtime.noteStatus(id, evseId, connectorId, p.connectorStatus);
    return {};
  });

  handle('MeterValues', async ({ params }) => {
    const p = params || {};
    const evseId = Math.max(0, Number(p.evseId) || 1);
    const connectorId = Math.max(0, Number(p.connectorId) || 1);
    await applyMeterValues(ctx, id, evseId, connectorId, p.meterValue, protocol);
    return {};
  });

  handle('TransactionEvent', async ({ params }) => {
    const p = params || {};
    const evseId = Math.max(0, Number(p.evse && p.evse.id) || 1);
    const connectorId = Math.max(0, Number(p.evse && p.evse.connectorId) || 1);
    const txInfo = p.transactionInfo || {};
    const txId = txInfo.transactionId;
    const idTag = p.idToken && p.idToken.idToken;
    const idTokenType = p.idToken && p.idToken.type;
    const ts = p.timestamp || new Date().toISOString();

    if (Array.isArray(p.meterValue)) await applyMeterValues(ctx, id, evseId, connectorId, p.meterValue, protocol);
    if (typeof p.numberOfPhasesUsed === 'number') await write(`${id}.transactions.numberPhases`, p.numberOfPhasesUsed, 'status');

    const wh = extractEnergyImportRegisterWh(p.meterValue, protocol);
    const type = p.eventType === 'Started' ? 'Start' : p.eventType === 'Ended' ? 'Stop' : 'Update';
    await ctx.states.pushTransactionEvent(id, {
      type,
      txId,
      evseId,
      connectorId,
      idTag,
      idTokenType,
      meterStart: type === 'Start' ? wh : undefined,
      meterStop: type === 'Stop' ? wh : undefined,
      reason: type === 'Stop' ? (txInfo.stoppedReason || p.triggerReason) : undefined,
      chargingState: txInfo.chargingState,
      triggerReason: p.triggerReason,
      seqNo: p.seqNo,
      ts,
    });

    return p.idToken ? { idTokenInfo: { status: 'Accepted' } } : {};
  });

  handle('FirmwareStatusNotification', async ({ params }) => {
    await write(`${id}.info.firmwareStatus`, params && params.status, 'status');
    return {};
  });

  handle('LogStatusNotification', async ({ params }) => {
    await write(`${id}.info.logStatus`, params && params.status, 'status');
    return {};
  });

  handle('DataTransfer', async ({ params }) => {
    const p = params || {};
    const vin = findVinInPayload(p.data);
    if (vin) await write(`${id}.info.vin`, vin, 'static');
    return { status: 'Accepted' };
  });

  handle('NotifyEVChargingNeeds', async ({ params }) => {
    const p = params || {};
    const needs = p.chargingNeeds || {};
    const dc = needs.dcChargingParameters || {};
    const ac = needs.acChargingParameters || {};
    const v2x = needs.v2xChargingParameters || {};
    const finite = (...values) => {
      for (const value of values) {
        if (value === undefined || value === null || String(value).trim() === '') continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return undefined;
    };
    const evseId = Math.max(0, Number(p.evseId) || 1);
    const timestamp = p.timestamp || new Date().toISOString();
    if (ctx.states && typeof ctx.states.ensureStructure === 'function') await ctx.states.ensureStructure(id, evseId, 1);
    const soc = finite(dc.stateOfCharge, needs.stateOfCharge);
    const fields = {
      evseId,
      timestamp,
      requestedEnergyTransfer: needs.requestedEnergyTransfer,
      departureTime: needs.departureTime,
      stateOfCharge: soc,
      targetSoC: finite(v2x.targetSoC),
      fullSoC: finite(dc.fullSoC),
      bulkSoC: finite(dc.bulkSoC),
      energyAmountWh: finite(dc.energyAmount, ac.energyAmount),
      evEnergyCapacityWh: finite(dc.evEnergyCapacity),
      evMaxPowerW: finite(dc.evMaxPower, v2x.maxChargePower),
      evMaxCurrentA: finite(dc.evMaxCurrent, ac.evMaxCurrent, v2x.maxChargeCurrent),
      evMaxVoltageV: finite(dc.evMaxVoltage, ac.evMaxVoltage, v2x.maxVoltage),
      maxScheduleTuples: finite(p.maxScheduleTuples),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) {
        const category = key === 'stateOfCharge' || key === 'targetSoC' || key === 'fullSoC' || key === 'bulkSoC' ? 'soc' : 'status';
        await write(`${id}.evChargingNeeds.${key}`, value, category);
      }
    }
    if (soc !== undefined) {
      const socId = await ctx.states.ensureAggState(id, 'SoC', '%');
      await write(socId, soc, 'soc');
      if (ctx.runtime && typeof ctx.runtime.noteSoc === 'function') await ctx.runtime.noteSoc(id, timestamp);
    }
    return { status: 'Accepted' };
  });

  handle('NotifyReport', async ({ params }) => {
    try {
      if (ctx.dm && typeof ctx.dm.ingestNotifyReport === 'function') await ctx.dm.ingestNotifyReport(id, protocol, params || {});
    } catch (e) {
      if (ctx.log && ctx.log.warn) ctx.log.warn(`NotifyReport ingest failed for ${id}: ${e}`);
    }
    return {};
  });

  // Certificate/security workflows require a PKI backend. Fail explicitly until one is configured.
  handle('SignCertificate', () => ({ status: 'Rejected' }));
  handle('Get15118EVCertificate', () => ({ status: 'Failed', exiResponse: '' }));
  handle('GetCertificateStatus', () => ({ status: 'Failed' }));
  handle('InstallCertificate', () => ({ status: 'Rejected' }));
  handle('CertificateSigned', () => ({ status: 'Rejected' }));

  client.handle(async ({ method, params }) => {
    if (ctx.runtime && typeof ctx.runtime.noteMessage === 'function') await ctx.runtime.noteMessage(id, method);
    await capture(method, params);
    return auto(method, { preferFailure: true });
  });
}

module.exports = { registerV2Handlers };
