'use strict';
function registerHandlers(client, ctx) {
  const id = client.identity;
  client.handle('BootNotification', ({ params }) => {
    const cs = (params && params.chargingStation) || {};
    ctx.states.upsertIdentityMeta(id, { protocol: 'ocpp2.1', ...cs }).catch(()=>{});
    const interval = (ctx.config.heartbeatIntervalSec || 300) | 0;
    if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.heartbeatInterval`, interval, true);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval };
  });
  client.handle('Authorize', () => ({ idTokenInfo: { status: 'Accepted' }}));
  client.handle('StatusNotification', async ({ params }) => {
    const evseId = (params && params.evseId) != null ? params.evseId : 0;
    const connectorId = (params && params.connectorId) != null ? params.connectorId : 0;
    await ctx.states.upsertEvseState(id, evseId, connectorId, {
      status: (params && (params.connectorStatus || params.status)) || undefined,
      timestamp: (params && params.timestamp) || new Date().toISOString(),
    });
    return {};
  });
  client.handle('TransactionEvent', async ({ params }) => { await ctx.states.pushTransactionEvent(id, { type: params && params.eventType, raw: params }); return {}; });
  client.handle('Heartbeat', () => { const now = new Date().toISOString(); if (ctx.setStateChangedAsync) ctx.setStateChangedAsync(`${id}.info.lastHeartbeat`, now, true); return { currentTime: now }; });
}
module.exports = { registerHandlers };
