'use strict';
function registerHandlers(client, ctx) {
  const id = client.identity;

  client.handle('BootNotification', ({ params }) => {
    const cs = (params && params.chargingStation) || {};
    ctx.log.info(`2.0.1 Boot from ${id}: ${(cs && cs.vendorName) || ''} ${(cs && cs.model) || ''}`);
    ctx.states.upsertIdentityMeta(id, {
      protocol: 'ocpp2.0.1',
      vendor: cs.vendorName, model: cs.model,
      serialNumber: cs.serialNumber, firmwareVersion: cs.firmwareVersion,
      reason: params && params.reason
    }).catch(()=>{});
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
  });

  client.handle('Authorize', ({ params }) => {
    const token = params && params.idToken && params.idToken.idToken;
    ctx.log.info(`Authorize(${id}): ${token}`);
    return { idTokenInfo: { status: 'Accepted' } };
  });

  client.handle('StatusNotification', async ({ params }) => {
    const evseId = (params && params.evseId) != null ? params.evseId : 0;
    const connectorId = (params && params.connectorId) != null ? params.connectorId : 0;
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: (params && (params.connectorStatus || params.status)) || undefined,
      timestamp: (params && params.timestamp) || new Date().toISOString(),
    });
    return {};
  });

  client.handle('TransactionEvent', async ({ params }) => {
    const p = params || {};
    const tx = p.transactionInfo || {};
    const evse = p.evse || {};
    const idToken = p.idToken || {};
    await ctx.states.pushTransactionEvent(id, {
      type: p.eventType,
      txId: tx.transactionId,
      seqNo: p.seqNo,
      idToken: idToken.idToken,
      evseId: evse.id,
      connectorId: evse.connectorId,
      meter: p.meterValue,
      raw: params,
    });
    return { totalCost: 0, chargingPriority: 0 };
  });

  client.handle('DataTransfer', () => ({ status: 'UnknownVendorId' }));
  client.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
}
module.exports = { registerHandlers };
