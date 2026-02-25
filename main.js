'use strict';
const utils = require('@iobroker/adapter-core');
const { OcppRpcServer } = require('./ocpp/server');

class Ocpp21Adapter extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'ocpp21' });
    this.server = null;
    this.runtimeIndex = new Map();

    // Runtime caches to avoid excessive object creation overhead
    this._dpObjCache = new Set();
    this._dpCounts = new Map();
    this._aliasDone = new Set();
    this._dmIndex = new Map(); // stateId -> { protocol, component, variable, attributeType }

    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
  }

  _stripNs(id) { return id.startsWith(this.namespace + '.') ? id.slice(this.namespace.length + 1) : id; }

  _sanitizeSeg(seg) {
    return String(seg || '')
      .trim()
      .replace(/[^A-Za-z0-9_\-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'x';
  }

  _looksLikeIsoTime(s) {
    if (typeof s !== 'string') return false;
    // very lightweight ISO-8601 date-time heuristic
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s);
  }

  async _setObjectNotExistsCached(id, obj) {
    if (this._dpObjCache.has(id)) return;
    await this.setObjectNotExistsAsync(id, obj);
    this._dpObjCache.add(id);
  }

  _flattenJson(value, out, path, depth, maxDepth, maxArray) {
    if (depth > maxDepth) {
      out.push({ path, value: JSON.stringify(value), kind: 'json' });
      return;
    }
    if (value === null || value === undefined) {
      out.push({ path, value: null, kind: 'null' });
      return;
    }
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out.push({ path, value, kind: t });
      return;
    }
    if (Array.isArray(value)) {
      const len = value.length;
      const n = Math.min(len, maxArray);
      for (let i = 0; i < n; i++) {
        this._flattenJson(value[i], out, path.concat(String(i)), depth + 1, maxDepth, maxArray);
      }
      if (len > maxArray) {
        out.push({ path: path.concat('_truncated'), value: `array(${len}) truncated to ${maxArray}`, kind: 'string' });
      }
      return;
    }
    if (t === 'object') {
      for (const [k, v] of Object.entries(value)) {
        this._flattenJson(v, out, path.concat(String(k)), depth + 1, maxDepth, maxArray);
      }
      return;
    }
    // fallback
    out.push({ path, value: String(value), kind: 'string' });
  }

  async captureOcppPayload(identity, protocol, direction, action, payload) {
    // Stores the full raw payload *and* creates leaf datapoints for all primitive values.
    // This is intentionally dynamic to avoid schema gaps and ensure "no limitations".
    const safeProto = this._sanitizeSeg(protocol);
    const safeDir = this._sanitizeSeg(direction);
    const safeAct = this._sanitizeSeg(action);

    const base = `${identity}.ocpp.${safeProto}.${safeDir}.${safeAct}`;

    await this._setObjectNotExistsCached(`${identity}.ocpp`, { type: 'channel', common: { name: 'ocpp' }, native: {} });
    await this._setObjectNotExistsCached(`${identity}.ocpp.${safeProto}`, { type: 'channel', common: { name: safeProto }, native: {} });
    await this._setObjectNotExistsCached(`${identity}.ocpp.${safeProto}.${safeDir}`, { type: 'channel', common: { name: safeDir }, native: {} });
    await this._setObjectNotExistsCached(base, { type: 'channel', common: { name: safeAct }, native: {} });
    await this._setObjectNotExistsCached(`${base}.data`, { type: 'channel', common: { name: 'data' }, native: {} });

    await this._setObjectNotExistsCached(`${base}.raw`, { type: 'state', common: { name: 'raw (JSON)', type: 'string', role: 'json', read: true, write: false }, native: {} });
    await this._setObjectNotExistsCached(`${base}.ts`, { type: 'state', common: { name: 'timestamp', type: 'string', role: 'value.time', read: true, write: false }, native: {} });
    await this._setObjectNotExistsCached(`${base}.count`, { type: 'state', common: { name: 'count', type: 'number', role: 'value', read: true, write: false, def: 0 }, native: {} });

    const now = new Date().toISOString();
    const key = `${identity}|${safeProto}|${safeDir}|${safeAct}`;
    const cnt = (this._dpCounts.get(key) || 0) + 1;
    this._dpCounts.set(key, cnt);

    let raw = '';
    try { raw = JSON.stringify(payload ?? {}); } catch (e) { raw = String(payload); }
    await this.setStateChangedAsync(`${base}.raw`, raw, true);
    await this.setStateChangedAsync(`${base}.ts`, now, true);
    await this.setStateChangedAsync(`${base}.count`, cnt, true);

    // Flatten leaf values
    const leaves = [];
    this._flattenJson(payload ?? {}, leaves, [], 0, 10, 50);
    for (const leaf of leaves) {
      const segs = (leaf.path || []).map((s) => this._sanitizeSeg(s));
      if (segs.length === 0) continue;
      const stateId = `${base}.data.${segs.join('.')}`;
      // ioBroker object id length safety
      if (stateId.length > 240) continue;

      let type = 'string';
      let role = 'text';
      if (leaf.kind === 'number') { type = 'number'; role = 'value'; }
      else if (leaf.kind === 'boolean') { type = 'boolean'; role = 'indicator'; }
      else if (leaf.kind === 'string') { type = 'string'; role = this._looksLikeIsoTime(leaf.value) ? 'value.time' : 'text'; }
      else if (leaf.kind === 'json') { type = 'string'; role = 'json'; }

      await this._setObjectNotExistsCached(stateId, {
        type: 'state',
        common: {
          name: segs[segs.length - 1],
          type,
          role,
          read: true,
          write: false,
        },
        native: {},
      });

      let val = leaf.value;
      if (val === null || val === undefined) {
        // Keep null as empty string for string states, and false/0 for other types.
        val = type === 'number' ? 0 : type === 'boolean' ? false : '';
      }
      if (type === 'number' && typeof val !== 'number') {
        const n = parseFloat(String(val));
        val = Number.isFinite(n) ? n : 0;
      }
      if (type === 'boolean' && typeof val !== 'boolean') {
        val = String(val).toLowerCase() === 'true' || String(val) === '1';
      }
      if (role === 'json' && typeof val !== 'string') {
        try { val = JSON.stringify(val); } catch (e) { val = String(val); }
      }

      await this.setStateChangedAsync(stateId, val, true);
    }
  }

  _dmKeyFromComponent(component) {
    const c = component || {};
    const name = this._sanitizeSeg(c.name);
    const inst = c.instance ? `_${this._sanitizeSeg(c.instance)}` : '';
    const evseId = c.evse && c.evse.id !== undefined ? `_evse${Number(c.evse.id)}` : '';
    const connId = c.evse && c.evse.connectorId !== undefined ? `_conn${Number(c.evse.connectorId)}` : '';
    return `${name}${inst}${evseId}${connId}`;
  }

  _dmKeyFromVariable(variable) {
    const v = variable || {};
    const name = this._sanitizeSeg(v.name);
    const inst = v.instance ? `_${this._sanitizeSeg(v.instance)}` : '';
    return `${name}${inst}`;
  }

  _dmParseValueByType(valueStr, dataType) {
    const s = valueStr === undefined || valueStr === null ? '' : String(valueStr);
    switch (String(dataType || '').toLowerCase()) {
      case 'boolean':
        return { type: 'boolean', val: s.toLowerCase() === 'true' || s === '1' };
      case 'integer': {
        const n = parseInt(s, 10);
        return { type: 'number', val: Number.isFinite(n) ? n : 0 };
      }
      case 'decimal': {
        const n = parseFloat(s);
        return { type: 'number', val: Number.isFinite(n) ? n : 0 };
      }
      case 'datetime':
        return { type: 'string', val: s };
      default:
        return { type: 'string', val: s };
    }
  }

  async ingestNotifyReport(identity, protocol, params) {
    // OCPP 2.x NotifyReport: store Device Model variables as dedicated datapoints.
    const reportData = (params && params.reportData) || [];
    if (!Array.isArray(reportData) || reportData.length === 0) return;

    // Ensure the base identity structure exists so we can mirror important values
    // (e.g. SoC) into the aggregated meterValues tree.
    try { await this.ensureStructure(identity); } catch (e) { /* ignore */ }

    await this._setObjectNotExistsCached(`${identity}.dm`, { type: 'channel', common: { name: 'device model (reported)' }, native: {} });

    for (const rd of reportData) {
      const component = rd && rd.component;
      const variable = rd && rd.variable;
      if (!component || !variable) continue;

      const cKey = this._dmKeyFromComponent(component);
      const vKey = this._dmKeyFromVariable(variable);
      const base = `${identity}.dm.${cKey}.${vKey}`;

      await this._setObjectNotExistsCached(`${identity}.dm.${cKey}`, { type: 'channel', common: { name: cKey }, native: {} });
      await this._setObjectNotExistsCached(base, { type: 'channel', common: { name: vKey }, native: {} });

      // characteristics
      const ch = rd.variableCharacteristics || {};
      await this._setObjectNotExistsCached(`${base}.characteristics`, { type: 'channel', common: { name: 'characteristics' }, native: {} });
      const chStates = {
        dataType: { type: 'string', role: 'text', val: ch.dataType },
        unit: { type: 'string', role: 'text', val: ch.unit },
        minLimit: { type: 'number', role: 'value', val: ch.minLimit },
        maxLimit: { type: 'number', role: 'value', val: ch.maxLimit },
        valuesList: { type: 'string', role: 'text', val: ch.valuesList },
        supportsMonitoring: { type: 'boolean', role: 'indicator', val: ch.supportsMonitoring },
      };
      for (const [k, def] of Object.entries(chStates)) {
        const sid = `${base}.characteristics.${k}`;
        await this._setObjectNotExistsCached(sid, { type: 'state', common: { name: k, type: def.type, role: def.role, read: true, write: false }, native: {} });
        if (def.val !== undefined) await this.setStateChangedAsync(sid, def.type === 'number' ? Number(def.val) : def.val, true);
      }

      const attrs = Array.isArray(rd.variableAttribute) ? rd.variableAttribute : [];
      for (const a of attrs) {
        const attrType = (a && a.type) || 'Actual';
        const mut = (a && a.mutability) || 'ReadWrite';
        const persistent = !!(a && a.persistent);
        const constant = !!(a && a.constant);
        const unit = ch.unit || '';

        const parsed = this._dmParseValueByType(a && a.value, ch.dataType);
        const valueId = `${base}.${this._sanitizeSeg(attrType)}.value`;
        const meta = { protocol, component, variable, attributeType: attrType };
        this._dmIndex.set(`${this.namespace}.${valueId}`, meta);

        await this._setObjectNotExistsCached(`${base}.${this._sanitizeSeg(attrType)}`, { type: 'channel', common: { name: attrType }, native: {} });
        await this._setObjectNotExistsCached(valueId, {
          type: 'state',
          common: {
            name: 'value',
            type: parsed.type,
            role: parsed.type === 'number' ? 'value' : parsed.type === 'boolean' ? 'indicator' : this._looksLikeIsoTime(parsed.val) ? 'value.time' : 'text',
            read: true,
            write: String(mut) !== 'ReadOnly',
            unit: unit || undefined,
          },
          native: { ocppDm: meta },
        });
        await this._setObjectNotExistsCached(`${base}.${this._sanitizeSeg(attrType)}.mutability`, { type: 'state', common: { name: 'mutability', type: 'string', role: 'text', read: true, write: false }, native: {} });
        await this._setObjectNotExistsCached(`${base}.${this._sanitizeSeg(attrType)}.persistent`, { type: 'state', common: { name: 'persistent', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} });
        await this._setObjectNotExistsCached(`${base}.${this._sanitizeSeg(attrType)}.constant`, { type: 'state', common: { name: 'constant', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} });

        if (a && a.value !== undefined) await this.setStateChangedAsync(valueId, parsed.val, true);

        // Mirror ConnectedEV.StateOfCharge (Device Model) into the common aggregate `meterValues.SoC`
        // so users get SoC even if the station reports it via Device Model instead of MeterValues.
        try {
          const compName = (component && component.name) ? String(component.name) : '';
          const varName = (variable && variable.name) ? String(variable.name) : '';
          if (compName.toLowerCase() === 'connectedev' && varName.toLowerCase() === 'stateofcharge' && String(attrType).toLowerCase() === 'actual') {
            if (typeof parsed.val === 'number' && Number.isFinite(parsed.val)) {
              const socAggId = await this.ensureAgg(identity, 'SoC', '%');
              await this.setStateChangedAsync(socAggId, parsed.val, true);
            }
          }
        } catch (e) {
          // ignore
        }

        await this.setStateChangedAsync(`${base}.${this._sanitizeSeg(attrType)}.mutability`, String(mut), true);
        await this.setStateChangedAsync(`${base}.${this._sanitizeSeg(attrType)}.persistent`, persistent, true);
        await this.setStateChangedAsync(`${base}.${this._sanitizeSeg(attrType)}.constant`, constant, true);
      }
    }
  }

  async ensureAliases(identity) {
    if (this._aliasDone.has(identity)) return;
    this._aliasDone.add(identity);

    const safeIdentity = this._sanitizeSeg(identity);
    const base = `alias.0.ocpp21.${this.instance}.${safeIdentity}`;
    try {
      await this.setForeignObjectNotExistsAsync('alias.0.ocpp21', { type: 'channel', common: { name: 'OCPP aliases' }, native: {} });
      await this.setForeignObjectNotExistsAsync(`alias.0.ocpp21.${this.instance}`, { type: 'channel', common: { name: `ocpp21 instance ${this.instance}` }, native: {} });
      await this.setForeignObjectNotExistsAsync(base, { type: 'channel', common: { name: identity }, native: {} });

      const mk = async (name, target, type, role, write) => {
        await this.setForeignObjectNotExistsAsync(`${base}.${name}`, {
          type: 'state',
          common: {
            name,
            type,
            role,
            read: true,
            write: !!write,
            alias: { id: `${this.namespace}.${target}` },
          },
          native: {},
        });
      };

      // Core shortcuts
      await mk('connected', `${identity}.info.connection`, 'boolean', 'indicator.connected', false);
      await mk('status', `${identity}.info.status`, 'string', 'indicator.status', false);
      await mk('protocol', `${identity}.info.protocol`, 'string', 'text', false);

      // RFID / auth token (best-effort unified)
      await mk('rfid', `${identity}.info.rfid`, 'string', 'text', false);
      await mk('rfidType', `${identity}.info.rfidType`, 'string', 'text', false);

      // Energy / power
      await mk('soc', `${identity}.meterValues.SoC`, 'number', 'value.battery', false);
      await mk('powerW', `${identity}.meterValues.Power_Active_Import`, 'number', 'value.power', false);
      await mk('energyWh', `${identity}.meterValues.Energy_Active_Import_Register`, 'number', 'value.energy', false);
      await mk('energyKWh', `${identity}.meterValues.Energy_Active_Import_Register_kWh`, 'number', 'value.energy', false);

      // Per-phase (aggregated, if provided by station)
      await mk('voltageL1', `${identity}.meterValues.Voltage_L1`, 'number', 'value.voltage', false);
      await mk('voltageL2', `${identity}.meterValues.Voltage_L2`, 'number', 'value.voltage', false);
      await mk('voltageL3', `${identity}.meterValues.Voltage_L3`, 'number', 'value.voltage', false);
      await mk('voltageL1N', `${identity}.meterValues.Voltage_L1N`, 'number', 'value.voltage', false);
      await mk('voltageL2N', `${identity}.meterValues.Voltage_L2N`, 'number', 'value.voltage', false);
      await mk('voltageL3N', `${identity}.meterValues.Voltage_L3N`, 'number', 'value.voltage', false);

      await mk('currentL1', `${identity}.meterValues.Current_Import_L1`, 'number', 'value.current', false);
      await mk('currentL2', `${identity}.meterValues.Current_Import_L2`, 'number', 'value.current', false);
      await mk('currentL3', `${identity}.meterValues.Current_Import_L3`, 'number', 'value.current', false);

      // Some stations report phase as L1-N (L1N after sanitizing). Provide aliases for that too.
      await mk('currentL1N', `${identity}.meterValues.Current_Import_L1N`, 'number', 'value.current', false);
      await mk('currentL2N', `${identity}.meterValues.Current_Import_L2N`, 'number', 'value.current', false);
      await mk('currentL3N', `${identity}.meterValues.Current_Import_L3N`, 'number', 'value.current', false);

      await mk('powerL1', `${identity}.meterValues.Power_Active_Import_L1`, 'number', 'value.power', false);
      await mk('powerL2', `${identity}.meterValues.Power_Active_Import_L2`, 'number', 'value.power', false);
      await mk('powerL3', `${identity}.meterValues.Power_Active_Import_L3`, 'number', 'value.power', false);

      await mk('powerL1N', `${identity}.meterValues.Power_Active_Import_L1N`, 'number', 'value.power', false);
      await mk('powerL2N', `${identity}.meterValues.Power_Active_Import_L2N`, 'number', 'value.power', false);
      await mk('powerL3N', `${identity}.meterValues.Power_Active_Import_L3N`, 'number', 'value.power', false);

      await mk('frequencyHz', `${identity}.meterValues.Frequency`, 'number', 'value.frequency', false);

      // Connector 1 convenience
      await mk('connector1Status', `${identity}.evse.1.connector.1.status`, 'string', 'indicator.status', false);
      await mk('connector1EnergyWh', `${identity}.evse.1.connector.1.meter.lastWh`, 'number', 'value.energy', false);
      await mk('connector1EnergyKWh', `${identity}.evse.1.connector.1.meter.lastKWh`, 'number', 'value.energy', false);

      // Transaction shortcuts
      await mk('txActive', `${identity}.transactions.transactionActive`, 'boolean', 'indicator.working', false);
      await mk('txId', `${identity}.transactions.last.id`, 'string', 'text', false);
      await mk('idTag', `${identity}.transactions.idTag`, 'string', 'text', false);
      await mk('txEnergyWh', `${identity}.transactions.lastTransactionConsumption`, 'number', 'value.energy', false);
      await mk('txEnergyKWh', `${identity}.transactions.lastTransactionConsumption_kWh`, 'number', 'value.energy', false);

      // Controls
      await mk('chargeLimit', `${identity}.control.chargeLimit`, 'number', 'value.power', true);
      await mk('numberPhases', `${identity}.control.numberOfPhases`, 'number', 'value', true);
      await mk('availability', `${identity}.control.availability`, 'boolean', 'switch.power', true);
    } catch (e) {
      // Alias namespace may not exist / may be restricted. Adapter should still run.
      this.log.debug(`alias creation skipped (${identity}): ${e}`);
    }
  }

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
      rfid: { type: 'string', role: 'text' },
      rfidType: { type: 'string', role: 'text' },
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
    await this.setObjectNotExistsAsync(`${identity}.control.numberOfPhases`, { type: 'state', common: { name: 'Number of phases (smart charging)', type: 'number', role: 'value', read: true, write: true, def: 3, min: 1, max: 3 }, native: {} });

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
    await this.setObjectNotExistsAsync(`${identity}.transactions.idTagType`, { type: 'state', common: { name: 'idToken type (OCPP 2.x)', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionActive`, { type: 'state', common: { name: 'Transaction active', type: 'boolean', role: 'switch.power', read: true, write: false, def: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionStartMeter`, { type: 'state', common: { name: 'Meter at transaction start', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionStartMeter_kWh`, { type: 'state', common: { name: 'Meter at transaction start (kWh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'kWh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionEndMeter`, { type: 'state', common: { name: 'Meter at transaction end', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.transactionEndMeter_kWh`, { type: 'state', common: { name: 'Meter at transaction end (kWh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'kWh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.lastTransactionConsumption`, { type: 'state', common: { name: 'Consumption by last transaction', type: 'number', role: 'value.power', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.lastTransactionConsumption_kWh`, { type: 'state', common: { name: 'Consumption by last transaction (kWh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'kWh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.numberPhases`, { type: 'state', common: { name: 'Number of phases used for charging', type: 'number', role: 'value', read: true, write: false }, native: {} });

    // Last transaction event (compat for 1.6 + 2.x)
    await this.setObjectNotExistsAsync(`${identity}.transactions.last`, { type: 'channel', common: { name: 'last transaction event' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.type`, { type: 'state', common: { name: 'type', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.id`, { type: 'state', common: { name: 'transaction id', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.connectorId`, { type: 'state', common: { name: 'connector id', type: 'number', role: 'value', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.idTag`, { type: 'state', common: { name: 'idTag', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStart`, { type: 'state', common: { name: 'meterStart', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStart_kWh`, { type: 'state', common: { name: 'meterStart (kWh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'kWh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStop`, { type: 'state', common: { name: 'meterStop', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.meterStop_kWh`, { type: 'state', common: { name: 'meterStop (kWh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'kWh' }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.reason`, { type: 'state', common: { name: 'reason', type: 'string', role: 'text', read: true, write: false }, native: {} });
    await this.setObjectNotExistsAsync(`${identity}.transactions.last.ts`, { type: 'state', common: { name: 'timestamp', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Connector channel
    const base = `${identity}.evse.${evseId}.connector.${connectorId}`;
    for (const [k, def] of Object.entries({status:'string', errorCode:'string', vendorErrorCode:'string', vendorId:'string', ts:'string'})) {
      await this.setObjectNotExistsAsync(`${base}.${k}`, { type: 'state', common: { name: k, type: def, role: 'value', read: true, write: false }, native: {} });
    }
    await this.setObjectNotExistsAsync(`${base}.meter`, { type: 'channel', common: { name: 'meter' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastWh`, { type: 'state', common: { name: 'last energy (Wh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastKWh`, { type: 'state', common: { name: 'last energy (kWh)', type: 'number', role: 'value.energy', read: true, write: false, unit: 'kWh' }, native: {} });
    await this.setObjectNotExistsAsync(`${base}.meter.lastTs`, { type: 'state', common: { name: 'last meter ts', type: 'string', role: 'value.time', read: true, write: false }, native: {} });

    // Convenience: ioBroker aliases for common datapoints
    await this.ensureAliases(identity);
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
          if (evt.idTag !== undefined) {
            await this.setStateChangedAsync(`${p}.idTag`, evt.idTag, true);
            await this.setStateChangedAsync(`${id}.transactions.idTag`, evt.idTag, true);
            await this.setStateChangedAsync(`${id}.info.rfid`, evt.idTag, true);
          }
          if (evt.idTokenType !== undefined) {
            await this.setStateChangedAsync(`${id}.transactions.idTagType`, String(evt.idTokenType), true);
            await this.setStateChangedAsync(`${id}.info.rfidType`, String(evt.idTokenType), true);
          }
          if (evt.meterStart !== undefined) {
            const wh = Number(evt.meterStart);
            await this.setStateChangedAsync(`${p}.meterStart`, wh, true);
            await this.setStateChangedAsync(`${p}.meterStart_kWh`, wh / 1000, true);
            await this.setStateChangedAsync(`${id}.transactions.transactionStartMeter`, wh, true);
            await this.setStateChangedAsync(`${id}.transactions.transactionStartMeter_kWh`, wh / 1000, true);
          }
          if (evt.meterStop !== undefined) {
            const whStop = Number(evt.meterStop);
            await this.setStateChangedAsync(`${p}.meterStop`, whStop, true);
            await this.setStateChangedAsync(`${p}.meterStop_kWh`, whStop / 1000, true);
            await this.setStateChangedAsync(`${id}.transactions.transactionEndMeter`, whStop, true);
            await this.setStateChangedAsync(`${id}.transactions.transactionEndMeter_kWh`, whStop / 1000, true);
            const startWh = (await this.getStateAsync(`${id}.transactions.transactionStartMeter`))?.val;
            if (typeof startWh === 'number') {
              const consWh = Math.max(0, whStop - startWh);
              await this.setStateChangedAsync(`${id}.transactions.lastTransactionConsumption`, consWh, true);
              await this.setStateChangedAsync(`${id}.transactions.lastTransactionConsumption_kWh`, consWh / 1000, true);
            }
          }
          if (evt.reason !== undefined) await this.setStateChangedAsync(`${p}.reason`, evt.reason, true);
          if (evt.ts !== undefined) await this.setStateChangedAsync(`${p}.ts`, evt.ts, true);
          if (evt.type === 'Start') await this.setStateChangedAsync(`${id}.transactions.transactionActive`, true, true);
          if (evt.type === 'Stop') await this.setStateChangedAsync(`${id}.transactions.transactionActive`, false, true);
        },
        setRfid: async (id, token, tokenType) => {
          await this.ensureStructure(id);
          if (token !== undefined && token !== null && String(token).length) {
            await this.setStateChangedAsync(`${id}.info.rfid`, String(token), true);
            await this.setStateChangedAsync(`${id}.transactions.idTag`, String(token), true);
          }
          if (tokenType !== undefined && tokenType !== null && String(tokenType).length) {
            await this.setStateChangedAsync(`${id}.info.rfidType`, String(tokenType), true);
            await this.setStateChangedAsync(`${id}.transactions.idTagType`, String(tokenType), true);
          }
        },
        ensureMetricState: this.ensureMetric.bind(this),
        ensureAggState: this.ensureAgg.bind(this),
      },
      runtime: {
        indexClient: (id, proto, client) => this.runtimeIndex.set(id, { proto, client }),
        unindexClient: (id) => this.runtimeIndex.delete(id),
        getClient: (id) => (this.runtimeIndex.get(id) || {}).client,
      },
      dp: {
        capture: this.captureOcppPayload.bind(this),
      },
      dm: {
        ingestNotifyReport: this.ingestNotifyReport.bind(this),
      },
      setStateChangedAsync: this.setStateChangedAsync.bind(this),
    };

    const protocols = []
      .concat(ctx.config.enable16 ? ['ocpp1.6'] : [])
      .concat(ctx.config.enable201 ? ['ocpp2.0.1'] : [])
      .concat(ctx.config.enable21 ? ['ocpp2.1'] : []);

    // strictMode=false ensures we do not reject newer/extended messages (important for full OCPP 1.6+ compatibility).
    this.server = new OcppRpcServer(ctx, { port: ctx.config.port, protocols, strictMode: false });
    await this.server.listen();
    this.log.info('ocpp21 adapter ready');
    this.subscribeStates('*');
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;
    const rel = this._stripNs(id);
    const mDmValue = rel.match(/^([^\.]+)\.dm\..+\.value$/);
    const mHard = rel.match(/^([^\.]+)\.control\.hardReset\.trigger$/);
    const mSoft = rel.match(/^([^\.]+)\.control\.softReset\.trigger$/);
    const mAvail = rel.match(/^([^\.]+)\.control\.availability$/);
    const mLimit = rel.match(/^([^\.]+)\.control\.chargeLimit$/);
    const mLimitType = rel.match(/^([^\.]+)\.control\.chargeLimitType$/);
    const mPhases = rel.match(/^([^\.]+)\.control\.numberOfPhases$/);
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
    const identity = (mDmValue || mHard || mSoft || mAvail || mLimit || mLimitType || mPhases || mRpcExec || mRpcMethod || mRpcPayload || mReqStartTrigger || mReqStartIdToken || mReqStartIdTokenType || mReqStartEvseId || mReqStartRemoteStartId || mReqStartProfile || mReqStopTrigger || mReqStopTxId)
      && (mDmValue?.[1] || mHard?.[1] || mSoft?.[1] || mAvail?.[1] || mLimit?.[1] || mLimitType?.[1] || mPhases?.[1] || mRpcExec?.[1] || mRpcMethod?.[1] || mRpcPayload?.[1] || mReqStartTrigger?.[1] || mReqStartIdToken?.[1] || mReqStartIdTokenType?.[1] || mReqStartEvseId?.[1] || mReqStartRemoteStartId?.[1] || mReqStartProfile?.[1] || mReqStopTrigger?.[1] || mReqStopTxId?.[1]);
    if (!identity) return;
    const entry = this.runtimeIndex.get(identity);
    const cli = entry?.client;
    const proto = entry?.proto;
    if (!cli) { this.log.warn(`No client for ${identity}`); return; }

    const call = async (method, payload) => {
      try { await this.captureOcppPayload(identity, proto, 'out', method, payload); } catch (e) { /* ignore */ }
      const res = await cli.call(method, payload);
      try { await this.captureOcppPayload(identity, proto, 'out', `${method}Response`, res); } catch (e) { /* ignore */ }
      return res;
    };
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

      if (mLimitType) {
        await this.setStateAsync(id, { val: state.val, ack: true });
        return;
      }

      // Device Model (OCPP 2.x): write back via SetVariables
      if (mDmValue) {
        if (proto === 'ocpp1.6') {
          await this.setStateAsync(id, { val: state.val, ack: true });
          return;
        }
        let meta = this._dmIndex.get(id);
        if (!meta) {
          const obj = await this.getObjectAsync(rel);
          meta = obj && obj.native && obj.native.ocppDm;
        }
        if (!meta || !meta.component || !meta.variable) {
          await this.setStateAsync(id, { val: state.val, ack: true });
          return;
        }
        const payload = {
          setVariableData: [
            {
              component: meta.component,
              variable: meta.variable,
              attributeType: meta.attributeType,
              attributeValue: String(state.val),
            },
          ],
        };
        try {
          const res = await call('SetVariables', payload);
          this.log.info(`SetVariables(${identity} ${meta.component.name}.${meta.variable.name} ${meta.attributeType}) -> ${JSON.stringify(res)}`);
        } catch (e) {
          this.log.warn(`SetVariables failed (${identity}): ${e}`);
        }
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
          const res = await call(method, payload);
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
      res = await call('RemoteStartTransaction', payload);
    } else {
      const payload = { idToken: { idToken, type: idTokenType }, remoteStartId };
      if (Number.isFinite(evseId) && evseId > 0) payload.evseId = evseId;
      if (chargingProfile) payload.chargingProfile = chargingProfile;
      res = await call('RequestStartTransaction', payload);
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
      res = await call('RemoteStopTransaction', { transactionId: Number.isFinite(n) ? n : txId });
    } else {
      res = await call('RequestStopTransaction', { transactionId: txId });
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
        const res = await call('Reset', payload);
        this.log.info(`Reset(${identity}, ${type}) -> ${JSON.stringify(res)}`);
        await this.setStateAsync(id, { val: false, ack: true });
        return;
      }
      if (mAvail) {
        const on = !!state.val;
        const res = proto === 'ocpp1.6'
          ? await call('ChangeAvailability', { connectorId: 0, type: on ? 'Operative' : 'Inoperative' })
          : await call('ChangeAvailability', { operationalStatus: on ? 'Operative' : 'Inoperative' });
        this.log.info(`ChangeAvailability(${identity}) -> ${JSON.stringify(res)}`);
        await this.setStateAsync(id, { val: on, ack: true });
        return;
      }

      if (mPhases) {
        let phases = Number(state.val);
        if (!Number.isFinite(phases)) phases = 3;
        phases = Math.max(1, Math.min(3, Math.round(phases)));

        // persist requested phases
        await this.setStateAsync(id, { val: phases, ack: true });

        // Re-apply charging profile if a limit is currently configured.
        const limitW = Number((await this.getStateAsync(`${identity}.control.chargeLimit`))?.val || 0);
        const rateUnit = String((await this.getStateAsync(`${identity}.control.chargeLimitType`))?.val || 'W').trim() || 'W';
        if (limitW > 0) {
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
                  chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW, numberPhases: phases }],
                },
              },
            };
            const res = await call('SetChargingProfile', profile);
            this.log.info(`SetChargingProfile(${identity}, ${limitW}${rateUnit}, phases=${phases}) -> ${JSON.stringify(res)}`);
          } else {
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
                    chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW, numberPhases: phases }],
                  },
                ],
              },
            };
            const res = await call('SetChargingProfile', profile);
            this.log.info(`SetChargingProfile(${identity}, ${limitW}${rateUnit}, phases=${phases}) -> ${JSON.stringify(res)}`);
          }
        }
        return;
      }

      if (mLimit) {
        const limitW = Number(state.val || 0);
        const rateUnit = String((await this.getStateAsync(`${identity}.control.chargeLimitType`))?.val || 'W').trim() || 'W';
        const phases = Math.max(1, Math.min(3, Math.round(Number((await this.getStateAsync(`${identity}.control.numberOfPhases`))?.val || 3))));

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
                chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW, numberPhases: phases }],
              },
            },
          };
          const res = await call('SetChargingProfile', profile);
          this.log.info(`SetChargingProfile(${identity}, ${limitW}${rateUnit}, phases=${phases}) -> ${JSON.stringify(res)}`);
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
                  chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW, numberPhases: phases }],
                },
              ],
            },
          };
          const res = await call('SetChargingProfile', profile);
          this.log.info(`SetChargingProfile(${identity}, ${limitW}${rateUnit}, phases=${phases}) -> ${JSON.stringify(res)}`);
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
