'use strict';
const utils = require('@iobroker/adapter-core');
const { OcppRpcServer } = require('./ocpp/server');

class Ocpp21Adapter extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'ocpp21' });
    this.server = null;
    this.runtimeIndex = new Map();
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
  }

  _stripNs(id) { return id.startsWith(this.namespace + '.') ? id.slice(this.namespace.length + 1) : id; }

  async ensureStructure(identity, evseId = 1, connectorId = 1) {
    await this.setObjectNotExistsAsync(identity, { type: 'channel', common: { name: identity }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.main`, { type: 'device', common: { name: 'Main' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.info`, { type: 'channel', common: { name: 'info' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.meterValues`, { type: 'channel', common: { name: 'meter values (aggregated)' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control`, { type: 'channel', common: { name: 'control' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions`, { type: 'channel', common: { name: 'transactions' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse`, { type: 'channel', common: { name: 'evse' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}`, { type: 'channel', common: { name: `evse ${evseId}` }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}.connector`, { type: 'channel', common: { name: 'connector' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}.connector.${connectorId}`, { type: 'channel', common: { name: `connector ${connectorId}` }, native: {} });

    const info = {
      connection: { type: 'boolean', role: 'indicator.connected', def: false },
      status: { type: 'string', role: 'indicator.status' },
      protocol: { type: 'string', role: 'text' },
      vendor: { type: 'string', role: 'text' },
      model: { type: 'string', role: 'text' },
      firmware: { type: 'string', role: 'text' },
      serialNumber: { type: 'string', role: 'text' },
      vin: { type: 'string', role: 'text' },
      chargePointSerialNumber: { type: 'string', role: 'text' },
      chargeBoxSerialNumber: { type: 'string', role: 'text' },
      iccid: { type: 'string', role: 'text' },
      imsi: { type: 'string', role: 'text' },
      meterType: { type: 'string', role: 'text' },
      meterSerialNumber: { type: 'string', role: 'text' },
      heartbeatInterval: { type: 'number', role: 'value.interval' },
      lastHeartbeat: { type: 'string', role: 'value.time' },
      firmwareStatus: { type: 'string', role: 'text' },
      diagnosticsStatus: { type: 'string', role: 'text' },
    };
    for (const [k, v] of Object.entries(info)) {
      await this.setObjectNotExistsAsync(`${identity}.info.${k}`, { type: 'state', common: { name: k, type: v.type, role: v.role, read: true, write: false, def: v.def }, native: {} });
    }

    // Controls (1.6)
    await this.setObjectNotExistsAsync(`${identity}.control.availability`, { type: 'state', common: { name: 'Switch availability', type: 'boolean', role: 'switch.power', read: true, write: true, def: true }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.hardReset.trigger`, { type: 'state', common: { name: 'Trigger hard reset', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.softReset.trigger`, { type: 'state', common: { name: 'Trigger soft reset', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.chargeLimit`, { type: 'state', common: { name: 'Limit Watt/Ampere of Charger', type: 'number', role: 'value.power', read: true, write: true, unit: 'W' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.chargeLimitType`, { type: 'state', common: { name: 'Type of Charge Limit', type: 'string', role: 'text', read: true, write: true, def: 'W' }, native: {} });

    // Generic RPC call interface (all versions)
    await this.setObjectNotExistsAsync(`${identity}.control.rpc`, { type: 'channel', common: { name: 'rpc' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.rpc.method`, { type: 'state', common: { name: 'OCPP method/action', type: 'string', role: 'text', read: true, write: true }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.rpc.payload`, { type: 'state', common: { name: 'OCPP payload (JSON)', type: 'string', role: 'json', read: true, write: true }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.rpc.execute`, { type: 'state', common: { name: 'Execute call', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.rpc.lastResponse`, { type: 'state', common: { name: 'Last response (JSON)', type: 'string', role: 'json', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.rpc.lastError`, { type: 'state', common: { name: 'Last error', type: 'string', role: 'text', read: true, write: false }, native: {} });


// Remote start/stop convenience (2.x: RequestStart/RequestStopTransaction, 1.6: RemoteStart/RemoteStopTransaction)
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction`, { type: 'channel', common: { name: 'RequestStartTransaction / RemoteStartTransaction' }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.idToken`, { type: 'state', common: { name: 'idToken / idTag', type: 'string', role: 'text', read: true, write: true }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.idTokenType`, { type: 'state', common: { name: 'idToken type (2.x)', type: 'string', role: 'text', read: true, write: true, def: 'Central' }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.evseId`, { type: 'state', common: { name: 'EVSE Id (2.x) / connectorId (1.6)', type: 'number', role: 'value', read: true, write: true, def: 1 }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.remoteStartId`, { type: 'state', common: { name: 'remoteStartId (2.x)', type: 'number', role: 'value', read: true, write: true, def: 1 }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.chargingProfile`, { type: 'state', common: { name: 'Optional chargingProfile JSON (2.x)', type: 'string', role: 'json', read: true, write: true }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.trigger`, { type: 'state', common: { name: 'Trigger start transaction', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.lastResponse`, { type: 'state', common: { name: 'Last response (JSON)', type: 'string', role: 'json', read: true, write: false }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStartTransaction.lastError`, { type: 'state', common: { name: 'Last error', type: 'string', role: 'text', read: true, write: false }, native: {} });

await this.setObjectNotExistsAsync(`${identity}.control.requestStopTransaction`, { type: 'channel', common: { name: 'RequestStopTransaction / RemoteStopTransaction' }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStopTransaction.transactionId`, { type: 'state', common: { name: 'transactionId (optional, empty = last)', type: 'string', role: 'text', read: true, write: true }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStopTransaction.trigger`, { type: 'state', common: { name: 'Trigger stop transaction', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStopTransaction.lastResponse`, { type: 'state', common: { name: 'Last response (JSON)', type: 'string', role: 'json', read: true, write: false }, native: {} });
await this.setObjectNotExistsAsync(`${identity}.control.requestStopTransaction.lastError`, { type: 'state', common: { name: 'Last error', type: 'string', role: 'text', read: true, write: false }, native: {} });
    // Transactions info
    await this.setObjectNotExistsAsync(`${identity}.transactions.idTag`, { type: 'state', common: { name: 'ID tag of transaction', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionActive`, { type: 'state', common: { name: 'Transaction active', type: 'boolean', role: 'switch.power', read: true, write: false, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionStartMeter`, { type: 'state', common: { name: 'Meter at transaction start', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionEndMeter`, { type: 'state', common: { name: 'Meter at transaction end', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.lastTransactionConsumption`, { type: 'state', common: { name: 'Consumption by last transaction', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.numberPhases`, { type: 'state', common: { name: 'Number of phases used for charging', type: 'number', role: 'value', read: true, write: false }, native: {} });

    // Last transaction event (compat for 1.6 + 2.x)
    await this.setObjectNotExistsAsync(`${identity}.transactions.last`, { type: 'channel', common: { name: 'last transaction event' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.type`, { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.id`, { type: 'state', common: { name: 'transaction id', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.connectorId`, { type: 'state', common: { name: 'connector id', type: 'number', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.idTag`, { type: 'state', common: { name: 'idTag', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStart`, { type: 'state', common: { name: 'meterStart', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStop`, { type: 'state', common: { name: 'meterStop', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.reason`, { type: 'state', common: { name: 'reason', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.ts`, { type: 'state', common: { name: 'timestamp', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Connector channel
    const base = `${identity}.evse.${evseId}.connector.${connectorId}`;
    for (const [k, def] of Object.entries({status:'string', errorCode:'string', vendorErrorCode:'string', vendorId:'string', ts:'string'})) {
      await this.setObjectNotExistsAsync(`${base}.${k}`, { type: 'state', common: { name: k, type: def, role: 'value', read: true, write: false }, native: {} });
    }
    await this.setObjectNotExistsAsync(`${base}.meter`, { type: 'channel', common: { name: 'meter' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastWh`, { type: 'state', common: { name: 'last energy (Wh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastTs`, { type: 'state', common: { name: 'last meter ts', type: 'string', role: 'value.time', read: true, write: false }, native: {} });
  }

  async ensureMetric(identity, evseId, connectorId, key, unit) {
    const id = `${identity}.evse.${evseId}.connector.${connectorId}.meter.${key}`;
    await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: key, type: 'number', role: 'value', read: true, write: false, unit }, native: {} });
    return id;
  }
  async ensureAgg(identity, key, unit) {
    const id = `${identity}.meterValues.${key}`;
    await this.setObjectNotExistsAsync(id, { type: 'state', common: { name: key, type: 'number', role: 'value', read: true, write: false, unit }, native: {} });
    return id;
  }

  async onReady() {
    const ctx = {
      log: this.log,
      config: {
        port: this.config.port ?? 9220,
        enable16: !!this.config.enable16,
        enable201: !!this.config.enable201,
        enable21: !!this.config.enable21,
        heartbeatIntervalSec: this.config.heartbeatIntervalSec ?? 300,
        identityAllowlist: this.config.identityAllowlist || [],
      },
      states: {
        setConnection: async (id, online) => { await this.ensureStructure(id); await this.setStateAsync(`${id}.info.connection`, online, true); },
        upsertIdentityMeta: async (id, meta) => { await this.ensureStructure(id);
          const infoKeys = ['protocol','vendor','model','firmwareVersion','serialNumber','chargePointSerialNumber','chargeBoxSerialNumber','iccid','imsi','meterType','meterSerialNumber'];
          const map = { firmwareVersion:'firmware' };
          for (const k of infoKeys) if (meta[k] !== undefined) await this.setStateChangedAsync(`${id}.info.${map[k]||k}`, meta[k], true);
        },
        upsertEvseState: async (id, evseId, connectorId, patch) => { await this.ensureStructure(id, evseId, connectorId);
          const p = `${id}.evse.${evseId}.connector.${connectorId}`;
          if (patch.status !== undefined) { await this.setStateChangedAsync(`${p}.status`, patch.status, true); await this.setStateChangedAsync(`${id}.info.status`, patch.status, true); }
          if (patch.errorCode !== undefined) await this.setStateChangedAsync(`${p}.errorCode`, patch.errorCode, true);
          if (patch.timestamp !== undefined) await this.setStateChangedAsync(`${p}.ts`, patch.timestamp, true);
          if (patch.info !== undefined) await this.setStateChangedAsync(`${p}.info`, patch.info, true);
          if (patch.vendorErrorCode !== undefined) await this.setStateChangedAsync(`${p}.vendorErrorCode`, patch.vendorErrorCode, true);
          if (patch.vendorId !== undefined) await this.setStateChangedAsync(`${p}.vendorId`, patch.vendorId, true);
        },
        pushTransactionEvent: async (id, evt) => { await this.ensureStructure(id);
          const p = `${id}.transactions.last`;
          if (evt.type !== undefined) await this.setStateChangedAsync(`${p}.type`, evt.type, true);
          if (evt.txId !== undefined) await this.setStateChangedAsync(`${p}.id`, String(evt.txId), true);
          if (evt.connectorId !== undefined) await this.setStateChangedAsync(`${p}.connectorId`, evt.connectorId, true);
          if (evt.idTag !== undefined) { await this.setStateChangedAsync(`${p}.idTag`, evt.idTag, true); await this.setStateChangedAsync(`${id}.transactions.idTag`, evt.idTag, true); }
          if (evt.meterStart !== undefined) { await this.setStateChangedAsync(`${p}.meterStart`, evt.meterStart, true); await this.setStateChangedAsync(`${id}.transactions.transactionStartMeter`, evt.meterStart, true); }
          if (evt.meterStop !== undefined) { await this.setStateChangedAsync(`${p}.meterStop`, evt.meterStop, true); await this.setStateChangedAsync(`${id}.transactions.transactionEndMeter`, evt.meterStop, true);
            const start = (await this.getStateAsync(`${id}.transactions.transactionStartMeter`))?.val;
            if (typeof start === 'number') await this.setStateChangedAsync(`${id}.transactions.lastTransactionConsumption`, Math.max(0, evt.meterStop - start), true);
          }
          if (evt.reason !== undefined) await this.setStateChangedAsync(`${p}.reason`, evt.reason, true);
          if (evt.ts !== undefined) await this.setStateChangedAsync(`${p}.ts`, evt.ts, true);
          if (evt.type === 'Start') await this.setStateChangedAsync(`${id}.transactions.transactionActive`, true, true);
          if (evt.type === 'Stop') await this.setStateChangedAsync(`${id}.transactions.transactionActive`, false, true);
        },
        ensureMetricState: this.ensureMetric.bind(this),
        ensureAggState: this.ensureAgg.bind(this),
      },
      runtime: {
        indexClient: (id, proto, client) => this.runtimeIndex.set(id, { proto, client }),
        unindexClient: (id) => this.runtimeIndex.delete(id),
        getClient: (id) => (this.runtimeIndex.get(id) || {}).client,
      },
      setStateChangedAsync: this.setStateChangedAsync.bind(this),
    };

    const protocols = []
      .concat(ctx.config.enable16 ? ['ocpp1.6'] : [])
      .concat(ctx.config.enable201 ? ['ocpp2.0.1'] : [])
      .concat(ctx.config.enable21 ? ['ocpp2.1'] : []);

    this.server = new OcppRpcServer(ctx, { port: ctx.config.port, protocols, strictMode: true });
    await this.server.listen();
    this.log.info('ocpp21 adapter ready');
    this.subscribeStates('*');
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;
    const rel = this._stripNs(id);
    const mHard = rel.match(/^([^\.]+)\.control\.hardReset\.trigger$/);
    const mSoft = rel.match(/^([^\.]+)\.control\.softReset\.trigger$/);
    const mAvail = rel.match(/^([^\.]+)\.control\.availability$/);
    const mLimit = rel.match(/^([^\.]+)\.control\.chargeLimit$/);
    const mRpcExec = rel.match(/^([^\.]+)\.control\.rpc\.execute$/);
    const mRpcMethod = rel.match(/^([^\.]+)\.control\.rpc\.method$/);
    const mRpcPayload = rel.match(/^([^\.]+)\.control\.rpc\.payload$/);
const mReqStartTrigger = rel.match(/^([^\.]+)\.control\.requestStartTransaction\.trigger$/);
const mReqStartIdToken = rel.match(/^([^\.]+)\.control\.requestStartTransaction\.idToken$/);
const mReqStartIdTokenType = rel.match(/^([^\.]+)\.control\.requestStartTransaction\.idTokenType$/);
const mReqStartEvseId = rel.match(/^([^\.]+)\.control\.requestStartTransaction\.evseId$/);
const mReqStartRemoteStartId = rel.match(/^([^\.]+)\.control\.requestStartTransaction\.remoteStartId$/);
const mReqStartProfile = rel.match(/^([^\.]+)\.control\.requestStartTransaction\.chargingProfile$/);
const mReqStopTrigger = rel.match(/^([^\.]+)\.control\.requestStopTransaction\.trigger$/);
const mReqStopTxId = rel.match(/^([^\.]+)\.control\.requestStopTransaction\.transactionId$/);
    const identity = (mHard || mSoft || mAvail || mLimit || mRpcExec || mRpcMethod || mRpcPayload || mReqStartTrigger || mReqStartIdToken || mReqStartIdTokenType || mReqStartEvseId || mReqStartRemoteStartId || mReqStartProfile || mReqStopTrigger || mReqStopTxId) && (mHard?.[1] || mSoft?.[1] || mAvail?.[1] || mLimit?.[1] || mRpcExec?.[1] || mRpcMethod?.[1] || mRpcPayload?.[1] || mReqStartTrigger?.[1] || mReqStartIdToken?.[1] || mReqStartIdTokenType?.[1] || mReqStartEvseId?.[1] || mReqStartRemoteStartId?.[1] || mReqStartProfile?.[1] || mReqStopTrigger?.[1] || mReqStopTxId?.[1]);
    if (!identity) return;
    const entry = this.runtimeIndex.get(identity);
    const cli = entry?.client;
    const proto = entry?.proto;
    if (!cli) { this.log.warn(`No client for ${identity}`); return; }
    try {
      // Ack storage states directly
      if (mRpcMethod) {
        await this.setStateAsync(id, { val: state.val, ack: true });
        return;
      }
      if (mRpcPayload) {
        await this.setStateAsync(id, { val: state.val, ack: true });
        return;
      }
if (mReqStartIdToken || mReqStartIdTokenType || mReqStartEvseId || mReqStartRemoteStartId || mReqStartProfile || mReqStopTxId) {
  await this.setStateAsync(id, { val: state.val, ack: true });
  return;
}

      if (mRpcExec) {
        const exec = !!state.val;
        if (!exec) { await this.setStateAsync(id, { val: false, ack: true }); return; }
        const method = String((await this.getStateAsync(`${identity}.control.rpc.method`))?.val || '').trim();
        const payloadStr = String((await this.getStateAsync(`${identity}.control.rpc.payload`))?.val || '').trim();
        let payload = {};
        if (payloadStr) {
          try { payload = JSON.parse(payloadStr); }
          catch (e) {
            await this.setStateChangedAsync(`${identity}.control.rpc.lastError`, `JSON parse error: ${e}`, true);
            await this.setStateAsync(id, { val: false, ack: true });
            return;
          }
        }
        if (!method) {
          await this.setStateChangedAsync(`${identity}.control.rpc.lastError`, 'Missing method', true);
          await this.setStateAsync(id, { val: false, ack: true });
          return;
        }
        try {
          const res = await cli.call(method, payload);
          await this.setStateChangedAsync(`${identity}.control.rpc.lastResponse`, JSON.stringify(res), true);
          await this.setStateChangedAsync(`${identity}.control.rpc.lastError`, '', true);
        } catch (e) {
          await this.setStateChangedAsync(`${identity}.control.rpc.lastError`, String(e && e.stack || e), true);
        }
        await this.setStateAsync(id, { val: false, ack: true });
        return;
      }
if (mReqStartTrigger) {
  const exec = !!state.val;
  if (!exec) { await this.setStateAsync(id, { val: false, ack: true }); return; }

  const idToken = String((await this.getStateAsync(`${identity}.control.requestStartTransaction.idToken`))?.val || '').trim();
  const idTokenType = String((await this.getStateAsync(`${identity}.control.requestStartTransaction.idTokenType`))?.val || 'Central').trim() || 'Central';
  const evseId = Number((await this.getStateAsync(`${identity}.control.requestStartTransaction.evseId`))?.val || 1);
  let remoteStartId = Number((await this.getStateAsync(`${identity}.control.requestStartTransaction.remoteStartId`))?.val || 0);
  if (!Number.isFinite(remoteStartId) || remoteStartId <= 0) remoteStartId = Math.floor(Math.random() * 1e9);

  const profileStr = String((await this.getStateAsync(`${identity}.control.requestStartTransaction.chargingProfile`))?.val || '').trim();
  let chargingProfile = undefined;
  if (profileStr) {
    try { chargingProfile = JSON.parse(profileStr); }
    catch (e) {
      await this.setStateChangedAsync(`${identity}.control.requestStartTransaction.lastError`, `chargingProfile JSON parse error: ${e}`, true);
      await this.setStateAsync(id, { val: false, ack: true });
      return;
    }
  }

  if (!idToken) {
    await this.setStateChangedAsync(`${identity}.control.requestStartTransaction.lastError`, 'Missing idToken/idTag', true);
    await this.setStateAsync(id, { val: false, ack: true });
    return;
  }

  try {
    let res;
    if (proto === 'ocpp1.6') {
      const payload = { connectorId: evseId || 1, idTag: idToken };
      res = await cli.call('RemoteStartTransaction', payload);
    } else {
      const payload = { idToken: { idToken, type: idTokenType }, remoteStartId };
      if (Number.isFinite(evseId) && evseId > 0) payload.evseId = evseId;
      if (chargingProfile) payload.chargingProfile = chargingProfile;
      res = await cli.call('RequestStartTransaction', payload);
    }
    await this.setStateChangedAsync(`${identity}.control.requestStartTransaction.lastResponse`, JSON.stringify(res), true);
    await this.setStateChangedAsync(`${identity}.control.requestStartTransaction.lastError`, '', true);
    await this.setStateAsync(`${identity}.control.requestStartTransaction.remoteStartId`, { val: remoteStartId, ack: true });
  } catch (e) {
    await this.setStateChangedAsync(`${identity}.control.requestStartTransaction.lastError`, String(e && e.stack || e), true);
  }

  await this.setStateAsync(id, { val: false, ack: true });
  return;
}

if (mReqStopTrigger) {
  const exec = !!state.val;
  if (!exec) { await this.setStateAsync(id, { val: false, ack: true }); return; }

  let txId = String((await this.getStateAsync(`${identity}.control.requestStopTransaction.transactionId`))?.val || '').trim();
  if (!txId) {
    txId = String((await this.getStateAsync(`${identity}.transactions.last.id`))?.val || '').trim();
  }
  if (!txId) {
    await this.setStateChangedAsync(`${identity}.control.requestStopTransaction.lastError`, 'Missing transactionId (and no last transaction)', true);
    await this.setStateAsync(id, { val: false, ack: true });
    return;
  }

  try {
    let res;
    if (proto === 'ocpp1.6') {
      const n = parseInt(txId, 10);
      res = await cli.call('RemoteStopTransaction', { transactionId: Number.isFinite(n) ? n : txId });
    } else {
      res = await cli.call('RequestStopTransaction', { transactionId: txId });
    }
    await this.setStateChangedAsync(`${identity}.control.requestStopTransaction.lastResponse`, JSON.stringify(res), true);
    await this.setStateChangedAsync(`${identity}.control.requestStopTransaction.lastError`, '', true);
    await this.setStateAsync(`${identity}.control.requestStopTransaction.transactionId`, { val: txId, ack: true });
  } catch (e) {
    await this.setStateChangedAsync(`${identity}.control.requestStopTransaction.lastError`, String(e && e.stack || e), true);
  }

  await this.setStateAsync(id, { val: false, ack: true });
  return;
}

      if (mHard || mSoft) {
        const type = proto === 'ocpp1.6' ? (mHard ? 'Hard' : 'Soft') : (mHard ? 'Immediate' : 'OnIdle');
        const payload = { type };
        const res = await cli.call('Reset', payload);
        this.log.info(`Reset(${identity}, ${type}) -> ${JSON.stringify(res)}`);
        await this.setStateAsync(id, { val: false, ack: true });
        return;
      }
      if (mAvail) {
        const on = !!state.val;
        const res = proto === 'ocpp1.6'
          ? await cli.call('ChangeAvailability', { connectorId: 0, type: on ? 'Operative' : 'Inoperative' })
          : await cli.call('ChangeAvailability', { operationalStatus: on ? 'Operative' : 'Inoperative' });
        this.log.info(`ChangeAvailability(${identity}) -> ${JSON.stringify(res)}`);
        await this.setStateAsync(id, { val: on, ack: true });
        return;
      }
      if (mLimit) {
        const limitW = Number(state.val || 0);
        const rateUnit = String((await this.getStateAsync(`${identity}.control.chargeLimitType`))?.val || 'W').trim() || 'W';

        if (proto === 'ocpp1.6') {
          const profile = {
            connectorId: 1,
            csChargingProfiles: {
              chargingProfileId: Math.floor(Math.random() * 1e9),
              stackLevel: 0,
              chargingProfilePurpose: 'TxDefaultProfile',
              chargingProfileKind: 'Absolute',
              chargingSchedule: {
                duration: 0,
                startSchedule: new Date().toISOString(),
                chargingRateUnit: rateUnit,
                chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW }],
              },
            },
          };
          const res = await cli.call('SetChargingProfile', profile);
          this.log.info(`SetChargingProfile(${identity}, ${limitW}${rateUnit}) -> ${JSON.stringify(res)}`);
        } else {
          // OCPP 2.x
          const chargingProfileId = Math.floor(Math.random() * 1e9);
          const chargingScheduleId = Math.floor(Math.random() * 1e9);
          const profile = {
            evseId: 0,
            chargingProfile: {
              id: chargingProfileId,
              stackLevel: 0,
              chargingProfilePurpose: 'ChargingStationMaxProfile',
              chargingProfileKind: 'Absolute',
              chargingSchedule: [
                {
                  id: chargingScheduleId,
                  startSchedule: new Date().toISOString(),
                  chargingRateUnit: rateUnit,
                  chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW }],
                },
              ],
            },
          };
          const res = await cli.call('SetChargingProfile', profile);
          this.log.info(`SetChargingProfile(${identity}, ${limitW}${rateUnit}) -> ${JSON.stringify(res)}`);
        }
        await this.setStateAsync(id, { val: limitW, ack: true });
        return;
      }
    } catch (e) {
      this.log.error(`control call failed: ${e}`);
    }
  }

  async onUnload(cb) { try { if (this.server) await this.server.close(); } finally { cb(); } }
}
if (module && require.main === module) { (() => new Ocpp21Adapter())(); }
module.exports = (options) => new Ocpp21Adapter(options);
