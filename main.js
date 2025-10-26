'use strict';
const utils = require('@iobroker/adapter-core');
const { OcppRpcServer } = require('./ocpp/server');

class Ocpp21Adapter extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'ocpp21',
    });
    this.server = null;
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
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
        setConnection: async (id, online) => { await this.setStateAsync(`${id}.info.connection`, online, true); },
        upsertIdentityMeta: async (id, meta) => {
          await this.setStateChangedAsync(`${id}.info.protocol`, meta.protocol, true);
          if (meta.vendor) await this.setStateChangedAsync(`${id}.info.vendor`, meta.vendor, true);
          if (meta.model) await this.setStateChangedAsync(`${id}.info.model`, meta.model, true);
          if (meta.firmwareVersion) await this.setStateChangedAsync(`${id}.info.firmware`, meta.firmwareVersion, true);
        },
        upsertEvseState: async (id, evseId, connectorId, patch) => {
          const p = `${id}.evse.${evseId}.connector.${connectorId}`;
          if (patch.status) await this.setStateChangedAsync(`${p}.status`, patch.status, true);
          if (patch.timestamp) await this.setStateChangedAsync(`${p}.ts`, patch.timestamp, true);
        },
        pushTransactionEvent: async (id, evt) => {
          const p = `${id}.transactions.last`;
          await this.setStateChangedAsync(`${p}.type`, evt.type, true);
          if (evt.txId) await this.setStateChangedAsync(`${p}.id`, evt.txId, true);
          if (evt.evseId != null) await this.setStateChangedAsync(`${p}.evseId`, evt.evseId, true);
          if (evt.connectorId != null) await this.setStateChangedAsync(`${p}.connectorId`, evt.connectorId, true);
        },
      },
      runtime: (() => { const index = new Map(); return {
        indexClient: (id, proto, client) => index.set(id, { proto, client }),
        unindexClient: (id) => index.delete(id),
      }; })(),
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
