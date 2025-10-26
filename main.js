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
    this.on('stateChange', this.onStateChange && this.onStateChange.bind ? this.onStateChange.bind(this) : () => {});
  }

  _stripNs(id) { return id.startsWith(this.namespace + '.') ? id.slice(this.namespace.length + 1) : id; }

  async ensureStructure(identity, evseId = 1, connectorId = 1) {
    await this.setObjectNotExistsAsync(identity, { type: 'channel', common: { name: identity }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.info`, { type: 'channel', common: { name: 'info' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions`, { type: 'channel', common: { name: 'transactions' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse`, { type: 'channel', common: { name: 'evse' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}`, { type: 'channel', common: { name: `evse ${evseId}` }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}.connector`, { type: 'channel', common: { name: 'connector' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.evse.${evseId}.connector.${connectorId}`, { type: 'channel', common: { name: `connector ${connectorId}` }, native: {} });

    // Info
    const infoStates = {
      connection: { type: 'boolean', role: 'indicator.connected', def: false },
      protocol: { type: 'string', role: 'text' },
      vendor: { type: 'string', role: 'text' },
      model: { type: 'string', role: 'text' },
      firmware: { type: 'string', role: 'text' },
      serialNumber: { type: 'string', role: 'text' },
      chargePointSerialNumber: { type: 'string', role: 'text' },
      chargeBoxSerialNumber: { type: 'string', role: 'text' },
      meterType: { type: 'string', role: 'text' },
      meterSerialNumber: { type: 'string', role: 'text' },
      iccid: { type: 'string', role: 'text' },
      imsi: { type: 'string', role: 'text' },
      heartbeatInterval: { type: 'number', role: 'value.interval' },
      lastHeartbeat: { type: 'string', role: 'value.time' },
      firmwareStatus: { type: 'string', role: 'text' },
      diagnosticsStatus: { type: 'string', role: 'text' },
    };
    for (const [k, v] of Object.entries(infoStates)) {
      await this.setObjectNotExistsAsync(`${identity}.info.${k}`, { type: 'state', common: { name: k, type: v.type, role: v.role, read: true, write: false, def: v.def }, native: {} });
    }

    // Connector base + meter
    const base = `${identity}.evse.${evseId}.connector.${connectorId}`;
    const connStates = {
      status: { type: 'string', role: 'value' },
      errorCode: { type: 'string', role: 'value' },
      vendorErrorCode: { type: 'string', role: 'value' },
      vendorId: { type: 'string', role: 'value' },
      ts: { type: 'string', role: 'value.time' },
    };
    for (const [k, v] of Object.entries(connStates)) {
      await this.setObjectNotExistsAsync(`${base}.${k}`, { type: 'state', common: { name: k, type: v.type, role: v.role, read: true, write: false }, native: {} });
    }
    await this.setObjectNotExistsAsync(`${base}.meter`, { type: 'channel', common: { name: 'meter' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastWh`, { type: 'state', common: { name: 'last energy (Wh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastTs`, { type: 'state', common: { name: 'last meter ts', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Transactions
    const txBase = `${identity}.transactions.last`;
    const txStates = {
      type: 'string', id: 'number', connectorId: 'number', idTag: 'string', meterStart: 'number', meterStop: 'number', ts: 'string'
    };
    for (const [k, t] of Object.entries(txStates)) {
      await this.setObjectNotExistsAsync(`${txBase}.${k}`, { type: 'state', common: { name: k, type: t, role: t==='string' ? 'text' : 'value', read: true, write: false }, native: {} });
    }
  }

  async ensureMetricState(identity, evseId, connectorId, key, unit) {
    const id = `${identity}.evse.${evseId}.connector.${connectorId}.meter.${key}`;
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
          if (meta.protocol !== undefined) await this.setStateChangedAsync(`${id}.info.protocol`, meta.protocol, true);
          if (meta.vendor !== undefined) await this.setStateChangedAsync(`${id}.info.vendor`, meta.vendor, true);
          if (meta.model !== undefined) await this.setStateChangedAsync(`${id}.info.model`, meta.model, true);
          if (meta.firmwareVersion !== undefined) await this.setStateChangedAsync(`${id}.info.firmware`, meta.firmwareVersion, true);
          if (meta.serialNumber !== undefined) await this.setStateChangedAsync(`${id}.info.serialNumber`, meta.serialNumber, true);
          if (meta.chargePointSerialNumber !== undefined) await this.setStateChangedAsync(`${id}.info.chargePointSerialNumber`, meta.chargePointSerialNumber, true);
          if (meta.chargeBoxSerialNumber !== undefined) await this.setStateChangedAsync(`${id}.info.chargeBoxSerialNumber`, meta.chargeBoxSerialNumber, true);
          if (meta.iccid !== undefined) await this.setStateChangedAsync(`${id}.info.iccid`, meta.iccid, true);
          if (meta.imsi !== undefined) await this.setStateChangedAsync(`${id}.info.imsi`, meta.imsi, true);
          if (meta.meterType !== undefined) await this.setStateChangedAsync(`${id}.info.meterType`, meta.meterType, true);
          if (meta.meterSerialNumber !== undefined) await this.setStateChangedAsync(`${id}.info.meterSerialNumber`, meta.meterSerialNumber, true);
        },
        upsertEvseState: async (id, evseId, connectorId, patch) => { await this.ensureStructure(id, evseId, connectorId);
          const p = `${id}.evse.${evseId}.connector.${connectorId}`;
          if (patch.status !== undefined) await this.setStateChangedAsync(`${p}.status`, patch.status, true);
          if (patch.errorCode !== undefined) await this.setStateChangedAsync(`${p}.errorCode`, patch.errorCode, true);
          if (patch.timestamp !== undefined) await this.setStateChangedAsync(`${p}.ts`, patch.timestamp, true);
          if (patch.info !== undefined) await this.setStateChangedAsync(`${p}.info`, patch.info, true);
          if (patch.vendorErrorCode !== undefined) await this.setStateChangedAsync(`${p}.vendorErrorCode`, patch.vendorErrorCode, true);
          if (patch.vendorId !== undefined) await this.setStateChangedAsync(`${p}.vendorId`, patch.vendorId, true);
        },
        pushTransactionEvent: async (id, evt) => { await this.ensureStructure(id);
          const p = `${id}.transactions.last`;
          if (evt.type !== undefined) await this.setStateChangedAsync(`${p}.type`, evt.type, true);
          if (evt.txId !== undefined) await this.setStateChangedAsync(`${p}.id`, evt.txId, true);
          if (evt.connectorId !== undefined) await this.setStateChangedAsync(`${p}.connectorId`, evt.connectorId, true);
          if (evt.idTag !== undefined) await this.setStateChangedAsync(`${p}.idTag`, evt.idTag, true);
          if (evt.meterStart !== undefined) await this.setStateChangedAsync(`${p}.meterStart`, evt.meterStart, true);
          if (evt.meterStop !== undefined) await this.setStateChangedAsync(`${p}.meterStop`, evt.meterStop, true);
          if (evt.ts !== undefined) await this.setStateChangedAsync(`${p}.ts`, evt.ts, true);
        },
        ensureMetricState: this.ensureMetricState.bind(this),
      },
      runtime: {
        indexClient: (id, proto, client) => this.runtimeIndex.set(id, { proto, client }),
        unindexClient: (id) => this.runtimeIndex.delete(id),
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
  }

  async onUnload(callback) {
    try { if (this.server) await this.server.close(); } finally { callback(); }
  }
}
if (module && require.main === module) { (() => new Ocpp21Adapter())(); }
module.exports = (options) => new Ocpp21Adapter(options);
