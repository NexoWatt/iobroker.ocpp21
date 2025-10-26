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
    await this.setObjectNotExistsAsync(`${identity}.control.availability`, { type: 'state', common: { name: 'Switch availability', type: 'boolean', role: 'switch.power', read: true, write: true, def: true }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.hardReset.trigger`, { type: 'state', common: { name: 'Trigger hard reset', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.softReset.trigger`, { type: 'state', common: { name: 'Trigger soft reset', type: 'boolean', role: 'button', read: true, write: true, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.chargeLimit`, { type: 'state', common: { name: 'Limit Watt/Ampere of Charger', type: 'number', role: 'value.power', read: true, write: true, unit: 'W' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.control.chargeLimitType`, { type: 'state', common: { name: 'Type of Charge Limit', type: 'string', role: 'text', read: true, write: true, def: 'W' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.idTag`, { type: 'state', common: { name: 'ID tag of transaction', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionActive`, { type: 'state', common: { name: 'Transaction active', type: 'boolean', role: 'switch.power', read: true, write: false, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionStartMeter`, { type: 'state', common: { name: 'Meter at transaction start', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionEndMeter`, { type: 'state', common: { name: 'Meter at transaction end', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.lastTransactionConsumption`, { type: 'state', common: { name: 'Consumption by last transaction', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.numberPhases`, { type: 'state', common: { name: 'Number of phases used for charging', type: 'number', role: 'value', read: true, write: false }, native: {} });
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
          if (evt.txId !== undefined) await this.setStateChangedAsync(`${p}.id`, evt.txId, true);
          if (evt.connectorId !== undefined) await this.setStateChangedAsync(`${p}.connectorId`, evt.connectorId, true);
          if (evt.idTag !== undefined) { await this.setStateChangedAsync(`${p}.idTag`, evt.idTag, true); await this.setStateChangedAsync(`${id}.transactions.idTag`, evt.idTag, true); }
          if (evt.meterStart !== undefined) { await this.setStateChangedAsync(`${p}.meterStart`, evt.meterStart, true); await this.setStateChangedAsync(`${id}.transactions.transactionStartMeter`, evt.meterStart, true); }
          if (evt.meterStop !== undefined) { await this.setStateChangedAsync(`${p}.meterStop`, evt.meterStop, true); await this.setStateChangedAsync(`${id}.transactions.transactionEndMeter`, evt.meterStop, true);
            const start = (await this.getStateAsync(`${id}.transactions.transactionStartMeter`))?.val;
            if (typeof start === 'number') await this.setStateChangedAsync(`${id}.transactions.lastTransactionConsumption`, Math.max(0, evt.meterStop - start), true);
          }
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
    const identity = (mHard || mSoft || mAvail || mLimit) && (mHard?.[1] || mSoft?.[1] || mAvail?.[1] || mLimit?.[1]);
    if (!identity) return;
    const cli = this.runtimeIndex.get(identity)?.client;
    if (!cli) { this.log.warn(`No client for ${identity}`); return; }
    try {
      if (mHard || mSoft) {
        const type = mHard ? 'Hard' : 'Soft';
        const res = await cli.call('Reset', { type });
        this.log.info(`Reset(${identity}, ${type}) -> ${JSON.stringify(res)}`);
        await this.setStateAsync(id, { val: false, ack: true });
        return;
      }
      if (mAvail) {
        const on = !!state.val;
        const res = await cli.call('ChangeAvailability', { connectorId: 0, type: on ? 'Operative' : 'Inoperative' });
        this.log.info(`ChangeAvailability(${identity}) -> ${JSON.stringify(res)}`);
        await this.setStateAsync(id, { val: on, ack: true });
        return;
      }
      if (mLimit) {
        const limitW = Number(state.val || 0);
        const profile = {
          connectorId: 1,
          csChargingProfiles: {
            chargingProfileId: Math.floor(Math.random()*1e9),
            stackLevel: 0,
            chargingProfilePurpose: 'TxDefaultProfile',
            chargingProfileKind: 'Absolute',
            chargingSchedule: { duration: 0, startSchedule: new Date().toISOString(), chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW }] }
          }
        };
        const res = await cli.call('SetChargingProfile', profile);
        this.log.info(`SetChargingProfile(${identity}, ${limitW}W) -> ${JSON.stringify(res)}`);
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
