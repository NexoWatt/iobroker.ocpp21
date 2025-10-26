'use strict';
const utils = require('@iobroker/adapter-core');
const { OcppRpcServer } = require('./ocpp/server');

class Ocpp21Adapter extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'ocpp21' });
    this.server = null;
    this.runtimeIndex = new Map(); // identity -> { proto, client }
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
  }

  _ns(id) { return `${this.namespace}.${id}`; }
  _stripNs(id) { return id.startsWith(this.namespace + '.') ? id.slice(this.namespace.length + 1) : id; }

  async ensureStructure(identity, evseId = 1, connectorId = 1) {
    // Channels
    await this.setObjectNotExistsAsync(identity, { type: 'channel', common: { name: identity }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.info`, { type: 'channel', common: { name: 'info' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control`, { type: 'channel', common: { name: 'control' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions`, { type: 'channel', common: { name: 'transactions' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse`, { type: 'channel', common: { name: 'evse' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}`, { type: 'channel', common: { name: `evse ${evseId}` }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}.connector`, { type: 'channel', common: { name: 'connector' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}.connector.${connectorId}`, { type: 'channel', common: { name: `connector ${connectorId}` }, native: {} });

    // Info states
    await this.setObjectNotExistsAsync(`${identity}.info.connection`, { type: 'state', common: { name: 'connected', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.info.protocol`, { type: 'state', common: { name: 'protocol', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.info.heartbeatInterval`, { type: 'state', common: { name: 'heartbeat interval (s)', type: 'number', role: 'value.interval', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.info.lastHeartbeat`, { type: 'state', common: { name: 'last heartbeat', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Connector states
    const base = `${identity}.evse.${evseId}.connector.${connectorId}`;
    await this.setObjectNotExistsAsync(`${base}.status`, { type: 'state', common: { name: 'status', type: 'string', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.errorCode`, { type: 'state', common: { name: 'errorCode', type: 'string', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.vendorErrorCode`, { type: 'state', common: { name: 'vendorErrorCode', type: 'string', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.vendorId`, { type: 'state', common: { name: 'vendorId', type: 'string', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.ts`, { type: 'state', common: { name: 'timestamp', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Meter subchannel
    await this.setObjectNotExistsAsync(`${base}.meter`, { type: 'channel', common: { name: 'meter' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastWh`, { type: 'state', common: { name: 'last energy (Wh)', type: 'number', role: 'value.energy', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastTs`, { type: 'state', common: { name: 'last meter timestamp', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Transactions
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.type`, { type: 'state', common: { name: 'last event type', type: 'string', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.id`, { type: 'state', common: { name: 'transaction id', type: 'number', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.connectorId`, { type: 'state', common: { name: 'connector id', type: 'number', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.idTag`, { type: 'state', common: { name: 'idTag', type: 'string', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStart`, { type: 'state', common: { name: 'meterStart', type: 'number', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStop`, { type: 'state', common: { name: 'meterStop', type: 'number', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.ts`, { type: 'state', common: { name: 'timestamp', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Controls
    await this.setObjectNotExistsAsync(`${identity}.control.remoteStart.idTag`, { type: 'state', common: { name: 'idTag', type: 'string', role: 'text', read: true, write: true }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.remoteStart.connectorId`, { type: 'state', common: { name: 'connectorId', type: 'number', role: 'value', read: true, write: true, def: 1 }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.remoteStart.trigger`, { type: 'state', common: { name: 'RemoteStartTransaction', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });

    await this.setObjectNotExistsAsync(`${identity}.control.remoteStop.transactionId`, { type: 'state', common: { name: 'transactionId', type: 'number', role: 'value', read: true, write: true }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.remoteStop.trigger`, { type: 'state', common: { name: 'RemoteStopTransaction', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });

    await this.setObjectNotExistsAsync(`${identity}.control.changeAvailability.connectorId`, { type: 'state', common: { name: 'connectorId', type: 'number', role: 'value', read: true, write: true, def: 0 }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.changeAvailability.operationalStatus`, { type: 'state', common: { name: 'Operative/Inoperative', type: 'string', role: 'text', read: true, write: true, def: 'Operative' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.changeAvailability.trigger`, { type: 'state', common: { name: 'ChangeAvailability', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
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
      // State facade used by handlers
      states: {
        setConnection: async (id, online) => { await this.ensureStructure(id); await this.setStateAsync(`${id}.info.connection`, online, true); },
        upsertIdentityMeta: async (id, meta) => { await this.ensureStructure(id); await this.setStateChangedAsync(`${id}.info.protocol`, meta.protocol, true);
          if (meta.vendor) await this.setStateChangedAsync(`${id}.info.vendor`, meta.vendor, true);
          if (meta.model) await this.setStateChangedAsync(`${id}.info.model`, meta.model, true);
          if (meta.firmwareVersion) await this.setStateChangedAsync(`${id}.info.firmware`, meta.firmwareVersion, true);
        },
        upsertEvseState: async (id, evseId, connectorId, patch) => {
          await this.ensureStructure(id, evseId, connectorId);
          const p = `${id}.evse.${evseId}.connector.${connectorId}`;
          if (patch.status !== undefined) await this.setStateChangedAsync(`${p}.status`, patch.status, true);
          if (patch.errorCode !== undefined) await this.setStateChangedAsync(`${p}.errorCode`, patch.errorCode, true);
          if (patch.timestamp !== undefined) await this.setStateChangedAsync(`${p}.ts`, patch.timestamp, true);
          if (patch.info !== undefined) await this.setStateChangedAsync(`${p}.info`, patch.info, true);
          if (patch.vendorErrorCode !== undefined) await this.setStateChangedAsync(`${p}.vendorErrorCode`, patch.vendorErrorCode, true);
          if (patch.vendorId !== undefined) await this.setStateChangedAsync(`${p}.vendorId`, patch.vendorId, true);
        },
        pushTransactionEvent: async (id, evt) => {
          await this.ensureStructure(id);
          const p = `${id}.transactions.last`;
          await this.setStateChangedAsync(`${p}.type`, evt.type || '', true);
          if (evt.idTag !== undefined) await this.setStateChangedAsync(`${p}.idTag`, evt.idTag, true);
          if (evt.txId !== undefined) await this.setStateChangedAsync(`${p}.id`, evt.txId, true);
          if (evt.connectorId !== undefined) await this.setStateChangedAsync(`${p}.connectorId`, evt.connectorId, true);
          if (evt.meterStart !== undefined) await this.setStateChangedAsync(`${p}.meterStart`, evt.meterStart, true);
          if (evt.meterStop !== undefined) await this.setStateChangedAsync(`${p}.meterStop`, evt.meterStop, true);
          if (evt.ts !== undefined) await this.setStateChangedAsync(`${p}.ts`, evt.ts, true);
        },
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

    // subscribe for control buttons
    this.subscribeStates('*');
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;
    const rel = this._stripNs(id);
    // pattern: <identity>.control.remoteStart.trigger
    const mRS = rel.match(/^([^\.]+)\.control\.remoteStart\.trigger$/);
    const mRStop = rel.match(/^([^\.]+)\.control\.remoteStop\.trigger$/);
    const mCA = rel.match(/^([^\.]+)\.control\.changeAvailability\.trigger$/);
    if (mRS) {
      const identity = mRS[1];
      const idTag = (await this.getStateAsync(`${identity}.control.remoteStart.idTag`))?.val || '';
      const connectorId = Number((await this.getStateAsync(`${identity}.control.remoteStart.connectorId`))?.val || 1);
      const cli = this.runtimeIndex.get(identity)?.client;
      if (!cli) { this.log.warn(`RemoteStart: no client for ${identity}`); return; }
      try {
        const res = await cli.call('RemoteStartTransaction', { idTag, connectorId });
        this.log.info(`RemoteStart(${identity}) -> ${JSON.stringify(res)}`);
      } catch (e) { this.log.error(`RemoteStart(${identity}) failed: ${e}`); }
      await this.setStateAsync(id, { val: false, ack: true });
      return;
    }
    if (mRStop) {
      const identity = mRStop[1];
      const transactionId = Number((await this.getStateAsync(`${identity}.control.remoteStop.transactionId`))?.val || 0);
      const cli = this.runtimeIndex.get(identity)?.client;
      if (!cli) { this.log.warn(`RemoteStop: no client for ${identity}`); return; }
      try {
        const res = await cli.call('RemoteStopTransaction', { transactionId });
        this.log.info(`RemoteStop(${identity}) -> ${JSON.stringify(res)}`);
      } catch (e) { this.log.error(`RemoteStop(${identity}) failed: ${e}`); }
      await this.setStateAsync(id, { val: false, ack: true });
      return;
    }
    if (mCA) {
      const identity = mCA[1];
      const connectorId = Number((await this.getStateAsync(`${identity}.control.changeAvailability.connectorId`))?.val || 0);
      const op = (await this.getStateAsync(`${identity}.control.changeAvailability.operationalStatus`))?.val || 'Operative';
      const type = (String(op).toLowerCase().startsWith('inop')) ? 'Inoperative' : 'Operative';
      const cli = this.runtimeIndex.get(identity)?.client;
      if (!cli) { this.log.warn(`ChangeAvailability: no client for ${identity}`); return; }
      try {
        const res = await cli.call('ChangeAvailability', { connectorId, type });
        this.log.info(`ChangeAvailability(${identity}) -> ${JSON.stringify(res)}`);
      } catch (e) { this.log.error(`ChangeAvailability(${identity}) failed: ${e}`); }
      await this.setStateAsync(id, { val: false, ack: true });
      return;
    }
  }

  async onUnload(callback) {
    try { if (this.server) await this.server.close(); } finally { callback(); }
  }
}

if (module && require.main === module) { (() => new Ocpp21Adapter())(); }
module.exports = (options) => new Ocpp21Adapter(options);
