'use strict';

// Shared helpers for all OCPP versions.

// Conversion of some commonly used units to a base unit.
function baseUnit(value, unit) {
  const map = {
    kWh: ['Wh', 1000],
    kW: ['W', 1000],
    Celcius: ['°C', 1],
    Celsius: ['°C', 1],
    Fahrenheit: ['°F', 1],
  };
  if (map[unit]) return { val: value * map[unit][1], unit: map[unit][0] };
  return { val: value, unit };
}

function normalizeKey(measurand, phase, location, context) {
  const parts = [measurand || 'Reading'];
  if (phase) parts.push(String(phase).replace(/\./g, ''));
  if (location && location !== 'Body') parts.push(location);
  if (context && context !== 'Sample.Periodic') parts.push(context);
  return parts.join('_').replace(/[^a-z0-9_.-]+/gi, '_');
}

const AGGREGATES = {
  'Energy.Active.Export.Register': 'Energy_Active_Export_Register',
  'Energy.Active.Import.Register': 'Energy_Active_Import_Register',
  'Energy.Reactive.Export.Register': 'Energy_Reactive_Export_Register',
  'Energy.Reactive.Import.Register': 'Energy_Reactive_Import_Register',
  'Energy.Active.Export.Interval': 'Energy_Active_Export_Interval',
  'Energy.Active.Import.Interval': 'Energy_Active_Import_Interval',
  'Energy.Reactive.Export.Interval': 'Energy_Reactive_Export_Interval',
  'Energy.Reactive.Import.Interval': 'Energy_Reactive_Import_Interval',
  'Power.Active.Export': 'Power_Active_Export',
  'Power.Active.Import': 'Power_Active_Import',
  'Power.Offered': 'Power_Offered',
  'Current.Import': 'Current_Import',
  'Current.Export': 'Current_Export',
  Voltage: 'Voltage',
  Frequency: 'Frequency',
  Temperature: 'Temperature',
  SoC: 'SoC',
};

function _loadSchemas(protocol) {
  // Prefer *official* schema bundles (generated from the OCA "all_files" archives)
  // and fall back to the schema bundle shipped inside ocpp-rpc.
  try {
    if (protocol === 'ocpp2.0.1') return require('./schemas/ocpp2_0_1_official.json');
    if (protocol === 'ocpp2.1') return require('./schemas/ocpp2_1_official.json');
  } catch (e) {
    // ignore
  }

  // Fallback: ocpp-rpc internal schemas.
  try {
    if (protocol === 'ocpp1.6') return require('ocpp-rpc/lib/schemas/ocpp1_6.json');
    if (protocol === 'ocpp2.0.1') return require('ocpp-rpc/lib/schemas/ocpp2_0_1.json');
    if (protocol === 'ocpp2.1') return require('ocpp-rpc/lib/schemas/ocpp2_1.json');
  } catch (e) {
    // In case ocpp-rpc changes its internal layout, keep the adapter running.
    // Missing schemas means auto responses are limited.
    return [];
  }
  return [];
}

function _parseSchemaId(id) {
  if (typeof id !== 'string' || !id) return null;
  // ocpp-rpc legacy style: urn:Action.req / urn:Action.conf
  let m = id.match(/^urn:([A-Za-z0-9_]+)\.(req|conf)$/);
  if (m) return { action: m[1], kind: m[2] === 'req' ? 'Request' : 'Response' };

  // ocpp-rpc 2.1 style: urn:ActionRequest / urn:ActionResponse
  m = id.match(/^urn:([A-Za-z0-9_]+)(Request|Response)$/);
  if (m) return { action: m[1], kind: m[2] };

  // official OCA schemas: urn:OCPP:...:ActionRequest / ...:ActionResponse
  m = id.match(/(?:^|:)([A-Za-z0-9_]+)(Request|Response)$/);
  if (m) return { action: m[1], kind: m[2] };
  return null;
}

function _getAllRequestActions(protocol) {
  const schemas = _loadSchemas(protocol);
  const actions = new Set();
  for (const s of schemas) {
    const id = s && s.$id;
    const parsed = _parseSchemaId(id);
    if (parsed && parsed.kind === 'Request') actions.add(parsed.action);
  }
  return [...actions].sort();
}

function _buildResponseSchemaMap(protocol) {
  const schemas = _loadSchemas(protocol);
  const map = new Map();
  for (const s of schemas) {
    const id = s && s.$id;
    const parsed = _parseSchemaId(id);
    if (parsed && parsed.kind === 'Response') map.set(parsed.action, s);
  }
  return map;
}

function _pickEnum(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const prefer = ['Accepted', 'OK', 'AcceptedOffline', 'Available'];
  for (const p of prefer) if (values.includes(p)) return p;
  return values[0];
}

function _patternExample(pattern) {
  if (typeof pattern !== 'string' || !pattern.length) return '0';
  // common: hex with fixed length
  let m = pattern.match(/^\^\[0-9A-Fa-f\]\{(\d+)\}\$?$/);
  if (m) return 'A'.repeat(Number(m[1]));
  m = pattern.match(/^\^\[0-9a-fA-F\]\{(\d+)\}\$?$/);
  if (m) return 'A'.repeat(Number(m[1]));
  // common: digits fixed length
  m = pattern.match(/^\^\[0-9\]\{(\d+)\}\$?$/);
  if (m) return '0'.repeat(Number(m[1]));
  // simple UUID
  if (pattern.includes('[0-9a-fA-F]') && pattern.includes('-') && pattern.includes('{8}') && pattern.includes('{4}') && pattern.includes('{12}')) {
    return '00000000-0000-0000-0000-000000000000';
  }
  // fallback
  return '0';
}

function _numberExample(schema) {
  if (!schema || typeof schema !== 'object') return 0;
  const isInt = schema.type === 'integer';
  let v = 0;
  if (schema.minimum !== undefined) v = schema.minimum;
  if (schema.exclusiveMinimum !== undefined) v = isInt ? (schema.exclusiveMinimum + 1) : (schema.exclusiveMinimum + 0.000001);
  if (schema.maximum !== undefined) v = Math.min(v, schema.maximum);
  if (schema.exclusiveMaximum !== undefined) v = Math.min(v, isInt ? (schema.exclusiveMaximum - 1) : (schema.exclusiveMaximum - 0.000001));
  if (schema.multipleOf) {
    const m = schema.multipleOf;
    if (m !== 0) v = Math.round(v / m) * m;
  }
  if (isInt) v = Math.trunc(v);
  return v;
}

function _generateFromSchema(schema, root, options, depth, refStack) {
  if (!schema || typeof schema !== 'object') return undefined;
  if (depth > 20) return undefined;
  if (schema.$ref) {
    const ref = schema.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/definitions/')) {
      const name = ref.slice('#/definitions/'.length);
      if (refStack.has(ref)) return undefined;
      const def = root && root.definitions ? root.definitions[name] : undefined;
      refStack.add(ref);
      const v = _generateFromSchema(def, root, options, depth + 1, refStack);
      refStack.delete(ref);
      return v;
    }
    return undefined;
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return _pickEnum(schema.enum);
  if (schema.oneOf && schema.oneOf.length) return _generateFromSchema(schema.oneOf[0], root, options, depth + 1, refStack);
  if (schema.anyOf && schema.anyOf.length) return _generateFromSchema(schema.anyOf[0], root, options, depth + 1, refStack);
  if (schema.allOf && schema.allOf.length) {
    // merge objects if possible
    const parts = schema.allOf.map(s => _generateFromSchema(s, root, options, depth + 1, refStack)).filter(v => v !== undefined);
    if (parts.every(p => p && typeof p === 'object' && !Array.isArray(p))) {
      return Object.assign({}, ...parts);
    }
    return parts[0];
  }

  let t = schema.type;
  if (Array.isArray(t)) t = t[0];

  switch (t) {
    case 'object': {
      const obj = {};
      const props = schema.properties || {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const k of required) {
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          obj[k] = _generateFromSchema(props[k], root, options, depth + 1, refStack);
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          obj[k] = _generateFromSchema(schema.additionalProperties, root, options, depth + 1, refStack);
        } else {
          obj[k] = undefined;
        }
      }
      // Some schemas use minProperties without required.
      const minProps = Number(schema.minProperties || 0);
      if (minProps > 0 && Object.keys(obj).length < minProps) {
        const keys = Object.keys(props);
        for (const k of keys) {
          if (Object.keys(obj).length >= minProps) break;
          if (obj[k] === undefined) obj[k] = _generateFromSchema(props[k], root, options, depth + 1, refStack);
        }
      }
      return obj;
    }
    case 'array': {
      const min = Number(schema.minItems || 0);
      const items = schema.items || {};
      const arr = [];
      for (let i = 0; i < min; i++) arr.push(_generateFromSchema(items, root, options, depth + 1, refStack));
      return arr;
    }
    case 'string': {
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'uri') return 'http://localhost/';
      if (schema.pattern) {
        const s = _patternExample(schema.pattern);
        if (schema.maxLength && s.length > schema.maxLength) return s.slice(0, schema.maxLength);
        if (schema.minLength && s.length < schema.minLength) return s.padEnd(schema.minLength, '0');
        return s;
      }
      const minLen = Number(schema.minLength || 0);
      const maxLen = schema.maxLength !== undefined ? Number(schema.maxLength) : undefined;
      let s = minLen > 0 ? '0'.repeat(minLen) : '0';
      if (maxLen !== undefined && s.length > maxLen) s = s.slice(0, maxLen);
      return s;
    }
    case 'integer':
    case 'number':
      return _numberExample(schema);
    case 'boolean':
      return false;
    default:
      return undefined;
  }
}

function createAutoResponder(protocol, options = {}) {
  const vendorId = options.vendorId || 'iobroker.ocpp21';
  const responseSchemas = _buildResponseSchemaMap(protocol);
  return function autoResponse(action) {
    const schema = responseSchemas.get(action);
    if (!schema) return {};
    const res = _generateFromSchema(schema, schema, { vendorId }, 0, new Set());
    // Ensure required customData.vendorId if customData is present and empty.
    if (res && typeof res === 'object' && !Array.isArray(res) && res.customData && typeof res.customData === 'object') {
      if (!('vendorId' in res.customData)) res.customData.vendorId = vendorId;
    }
    return res || {};
  };
}

// ---- Meter / sampling utilities ----

function _readUnitAndMultiplier(sample, protocol) {
  if (!sample || typeof sample !== 'object') return { unit: '', multiplier: 0 };
  if (protocol === 'ocpp1.6') {
    return { unit: sample.unit || '', multiplier: Number(sample.multiplier || 0) };
  }
  // ocpp2.x
  const uom = sample.unitOfMeasure || {};
  return { unit: uom.unit || sample.unit || '', multiplier: Number(uom.multiplier ?? sample.multiplier ?? 0) };
}

function _readNumericValue(sample, protocol) {
  const { multiplier } = _readUnitAndMultiplier(sample, protocol);
  const raw = sample && sample.value;
  const num = parseFloat(raw !== undefined ? String(raw) : '0');
  const val = num * Math.pow(10, Number(multiplier || 0));
  return Number.isFinite(val) ? val : 0;
}

function extractEnergyImportRegisterWh(meterValueArray, protocol) {
  const arr = Array.isArray(meterValueArray) ? meterValueArray : [];
  for (const mv of arr) {
    const samples = (mv && mv.sampledValue) || [];
    for (const sv of samples) {
      const meas = String((sv && sv.measurand) || '');
      if (!meas) continue;
      if (meas.toLowerCase().includes('energy.active.import.register')) {
        const rawUnit = _readUnitAndMultiplier(sv, protocol).unit;
        const rawVal = _readNumericValue(sv, protocol);
        const conv = baseUnit(rawVal, rawUnit);
        // We store energy in Wh.
        return conv.val;
      }
    }
  }
  return undefined;
}

async function applyMeterValues(ctx, identity, evseId, connectorId, meterValueArray, protocol) {
  if (!ctx || !ctx.setStateChangedAsync || !ctx.states) return;
  const id = identity;
  const arr = Array.isArray(meterValueArray) ? meterValueArray : [];
  const base = `${id}.evse.${evseId}.connector.${connectorId}.meter`;
  const phasesSeen = new Set();
  for (const mv of arr) {
    const ts = (mv && mv.timestamp) || new Date().toISOString();
    await ctx.setStateChangedAsync(`${base}.lastTs`, ts, true);
    const samples = (mv && mv.sampledValue) || [];
    for (const sv of samples) {
      const measurand = (sv && sv.measurand) || 'Reading';
      const rawUnit = _readUnitAndMultiplier(sv, protocol).unit;
      const rawVal = _readNumericValue(sv, protocol);
      const conv = baseUnit(rawVal, rawUnit);
      const key = normalizeKey(measurand, sv && sv.phase, sv && sv.location, sv && sv.context);
      const idState = await ctx.states.ensureMetricState(id, evseId, connectorId, key, conv.unit || rawUnit || '');
      await ctx.setStateChangedAsync(idState, conv.val, true);

      // Mirror into aggregates (top-level)
      const aggName = AGGREGATES[String(measurand)];
      if (aggName) {
        const aggId = await ctx.states.ensureAggState(id, aggName, conv.unit || rawUnit || '');
        await ctx.setStateChangedAsync(aggId, conv.val, true);
      }
      // Convenience helpers
      if (String(measurand).toLowerCase().includes('energy.active.import.register')) {
        await ctx.setStateChangedAsync(`${base}.lastWh`, conv.val, true);
      }
      if (sv && sv.phase) phasesSeen.add(String(sv.phase));
      if (String(measurand) === 'SoC') {
        const socId = await ctx.states.ensureAggState(id, 'SoC', '%');
        await ctx.setStateChangedAsync(socId, conv.val, true);
      }
    }
  }

  // numberPhases heuristic
  let n = 1;
  const ps = [...phasesSeen];
  if (ps.some(p => /L3/i.test(p))) n = 3;
  else if (ps.some(p => /L2/i.test(p))) n = 2;
  await ctx.setStateChangedAsync(`${id}.transactions.numberPhases`, n, true);
}

function _findVinDeep(obj, depth = 0) {
  if (depth > 6) return undefined;
  if (!obj) return undefined;
  if (typeof obj === 'string') {
    // Sometimes VIN is embedded in a text.
    const m = obj.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
    if (m) return m[1];
    return undefined;
  }
  if (typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const v = _findVinDeep(it, depth + 1);
      if (v) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && k.toLowerCase() === 'vin') {
      const s = typeof v === 'string' ? v.trim() : undefined;
      if (s && /[A-HJ-NPR-Z0-9]{17}/.test(s)) return s.match(/[A-HJ-NPR-Z0-9]{17}/)[0];
    }
    const found = _findVinDeep(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

module.exports = {
  AGGREGATES,
  baseUnit,
  normalizeKey,
  createAutoResponder,
  getAllRequestActions: _getAllRequestActions,
  applyMeterValues,
  extractEnergyImportRegisterWh,
  findVinInPayload: _findVinDeep,
};
