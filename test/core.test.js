'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeStationIdentity,
  heartbeatTimeoutMs,
  commandTimeoutMs,
  buildTriggerPayload,
  statusImpliesZero,
  chargingStateImpliesZero,
  isActualPowerOrCurrentId,
  dataFreshForEos,
  shouldRepublishCachedState,
  selectCachedStatesForRepublish,
  takeRotatingItems,
  parseDeviceModelValue,
} = require('../ocpp/freshness');
const { applyMeterValues, createAutoResponder } = require('../ocpp/common');
const { registerHandlers: register16 } = require('../ocpp/v16');
const { registerHandlers: register201 } = require('../ocpp/v201');
const { registerHandlers: register21 } = require('../ocpp/v21');

test('station identities are deterministic and safe for ioBroker object IDs', () => {
  assert.equal(sanitizeStationIdentity('DC_FAST_01'), 'DC_FAST_01');
  const sanitized = sanitizeStationIdentity('DC.Fast/01 West');
  assert.match(sanitized, /^DC_Fast_01_West_[0-9a-f]{8}$/);
  assert.equal(sanitized, sanitizeStationIdentity('DC.Fast/01 West'));
  assert.equal(/[.\s/]/.test(sanitized), false);
});

test('heartbeat timeout applies a bounded safety factor', () => {
  assert.equal(heartbeatTimeoutMs(60, 2.5), 150000);
  assert.equal(heartbeatTimeoutMs(0, 0), 750000);
  assert.equal(heartbeatTimeoutMs(10, 99), 100000);
});

test('OCPP command timeout uses seconds and remains bounded', () => {
  assert.equal(commandTimeoutMs(20), 20000);
  assert.equal(commandTimeoutMs(1), 5000);
  assert.equal(commandTimeoutMs(999), 120000);
});

test('TriggerMessage payloads are protocol-correct', () => {
  assert.deepEqual(buildTriggerPayload('ocpp1.6', 'MeterValues', 2, 3), {
    requestedMessage: 'MeterValues',
    connectorId: 3,
  });
  assert.deepEqual(buildTriggerPayload('ocpp2.1', 'StatusNotification', 2, 3), {
    requestedMessage: 'StatusNotification',
    evse: { id: 2, connectorId: 3 },
  });
});

test('safe-zero rules only match states with no energy transfer', () => {
  assert.equal(statusImpliesZero('ocpp1.6', 'Available'), true);
  assert.equal(statusImpliesZero('ocpp1.6', 'SuspendedEVSE'), true);
  assert.equal(statusImpliesZero('ocpp1.6', 'Charging'), false);
  assert.equal(statusImpliesZero('ocpp2.1', 'Available'), true);
  assert.equal(statusImpliesZero('ocpp2.1', 'Occupied'), false);
  assert.equal(chargingStateImpliesZero('SuspendedEV'), true);
  assert.equal(chargingStateImpliesZero('Charging'), false);
  assert.equal(isActualPowerOrCurrentId('station.meterValues.Power_Active_Import'), true);
  assert.equal(isActualPowerOrCurrentId('station.meterValues.Power_Offered'), false);
});

test('EOS freshness requires canonical active-import power or a safe zero', () => {
  assert.equal(dataFreshForEos(true, true, false), true);
  assert.equal(dataFreshForEos(true, false, true), true);
  assert.equal(dataFreshForEos(true, false, false), false);
  assert.equal(dataFreshForEos(false, true, true), false);
});

test('cached telemetry is republished per datapoint and never by unrelated freshness', () => {
  const now = 1_000_000;
  const options = { now, telemetryMaxAgeSec: 90, socMaxAgeSec: 300, safeZero: false };
  assert.equal(shouldRepublishCachedState({ category: 'realtime', updatedAt: now - 20_000 }, options), true);
  assert.equal(shouldRepublishCachedState({ category: 'realtime', updatedAt: now - 91_000 }, options), false);
  assert.equal(shouldRepublishCachedState({ category: 'soc', updatedAt: now - 299_000 }, options), true);
  assert.equal(shouldRepublishCachedState({ category: 'soc', updatedAt: now - 301_000 }, options), false);
  assert.equal(shouldRepublishCachedState({ category: 'safeZero', updatedAt: now - 500_000 }, options), false);
  assert.equal(shouldRepublishCachedState({ category: 'safeZero', updatedAt: now - 500_000 }, { ...options, safeZero: true }), true);
  assert.equal(shouldRepublishCachedState({ category: 'status', updatedAt: 0 }, options), true);
});

test('republish and connector limits rotate fairly instead of starving later entries', () => {
  const now = 1_000_000;
  const cache = new Map(Array.from({ length: 7 }, (_, index) => [
    `station.state${index}`,
    { category: 'status', updatedAt: now, val: index, ack: true },
  ]));
  const first = selectCachedStatesForRepublish(cache.entries(), { now, cursor: 0, limit: 3 });
  const second = selectCachedStatesForRepublish(cache.entries(), { now, cursor: first.nextCursor, limit: 3 });
  const third = selectCachedStatesForRepublish(cache.entries(), { now, cursor: second.nextCursor, limit: 3 });
  assert.deepEqual(first.entries.map(([id]) => id), ['station.state0', 'station.state1', 'station.state2']);
  assert.deepEqual(second.entries.map(([id]) => id), ['station.state3', 'station.state4', 'station.state5']);
  assert.deepEqual(third.entries.map(([id]) => id), ['station.state6', 'station.state0', 'station.state1']);

  const connectors = ['1:1', '2:1', '3:1', '4:1', '5:1'];
  const connectorsFirst = takeRotatingItems(connectors, 0, 2);
  const connectorsSecond = takeRotatingItems(connectors, connectorsFirst.nextCursor, 2);
  const connectorsThird = takeRotatingItems(connectors, connectorsSecond.nextCursor, 2);
  assert.deepEqual(connectorsFirst.items, ['1:1', '2:1']);
  assert.deepEqual(connectorsSecond.items, ['3:1', '4:1']);
  assert.deepEqual(connectorsThird.items, ['5:1', '1:1']);
});

test('Device Model values are parsed strictly', () => {
  assert.deepEqual(parseDeviceModelValue('true', 'boolean'), { type: 'boolean', val: true });
  assert.deepEqual(parseDeviceModelValue('0', 'boolean'), { type: 'boolean', val: false });
  assert.deepEqual(parseDeviceModelValue('not-boolean', 'boolean'), { type: 'boolean', val: undefined });
  assert.deepEqual(parseDeviceModelValue('12', 'integer'), { type: 'number', val: 12 });
  assert.deepEqual(parseDeviceModelValue('12.5', 'integer'), { type: 'number', val: undefined });
  assert.deepEqual(parseDeviceModelValue('12foo', 'decimal'), { type: 'number', val: undefined });
});

function createMeterContext() {
  const writes = [];
  const phaseCache = new Map();
  const meterNotes = [];
  const socNotes = [];
  const ctx = {
    setStateFreshAsync: async (id, val, ack, category) => {
      writes.push({ id, val, ack, category });
    },
    states: {
      ensureMetricState: async (identity, evseId, connectorId, key) => `${identity}.evse.${evseId}.connector.${connectorId}.meter.${key}`,
      ensureAggState: async (identity, key) => `${identity}.meterValues.${key}`,
    },
    runtime: {
      recordPhaseMetric(identity, evseId, connectorId, measurand, phase, value, unit, ts) {
        const key = `${identity}|${evseId}|${connectorId}|${measurand}`;
        if (!phaseCache.has(key)) phaseCache.set(key, new Map());
        phaseCache.get(key).set(String(phase).replace(/N$/i, ''), { value, unit, ts });
      },
      getPhaseMetricTotal(identity, evseId, connectorId, measurand) {
        const key = `${identity}|${evseId}|${connectorId}|${measurand}`;
        const samples = phaseCache.get(key);
        if (!samples || samples.size === 0) return undefined;
        return {
          value: [...samples.values()].reduce((sum, sample) => sum + sample.value, 0),
          unit: [...samples.values()][0].unit,
        };
      },
      async noteMeterValue(identity, evseId, connectorId, timestamp, flags) {
        meterNotes.push({ identity, evseId, connectorId, timestamp, flags });
      },
      async noteSoc(identity, timestamp) {
        socNotes.push({ identity, timestamp });
      },
    },
  };
  return { ctx, writes, meterNotes, socNotes };
}

function lastWrite(writes, id) {
  return [...writes].reverse().find((entry) => entry.id === id);
}

test('meter values stay fresh, aggregate phases across messages and mirror Wh to kWh', async () => {
  const { ctx, writes, meterNotes, socNotes } = createMeterContext();
  const station = 'DC_01';
  const timestamp = '2026-08-12T08:00:00.000Z';

  for (const [phase, power, current] of [['L1', 1000, 4], ['L2', 1200, 5], ['L3', 1300, 6]]) {
    await applyMeterValues(ctx, station, 1, 1, [{
      timestamp,
      sampledValue: [
        { measurand: 'Power.Active.Import', phase, value: power, unitOfMeasure: { unit: 'W' } },
        { measurand: 'Current.Import', phase, value: current, unitOfMeasure: { unit: 'A' } },
      ],
    }], 'ocpp2.1');
  }

  await applyMeterValues(ctx, station, 1, 1, [{
    timestamp,
    sampledValue: [
      { measurand: 'Energy.Active.Import.Register', value: 12345, unitOfMeasure: { unit: 'Wh' } },
      { measurand: 'SoC', value: 57, unitOfMeasure: { unit: '%' } },
    ],
  }], 'ocpp2.1');

  assert.equal(lastWrite(writes, `${station}.meterValues.Power_Active_Import`).val, 3500);
  assert.equal(lastWrite(writes, `${station}.meterValues.Current_Import`).val, 15);
  assert.equal(lastWrite(writes, `${station}.meterValues.Energy_Active_Import_Register_kWh`).val, 12.345);
  assert.equal(lastWrite(writes, `${station}.meterValues.SoC`).val, 57);
  assert.equal(meterNotes.length, 4, 'all valid MeterValues update general meter freshness');
  assert.equal(meterNotes.slice(0, 3).every((note) => note.flags.hasPower && note.flags.hasCurrent), true);
  assert.equal(meterNotes[3].flags.hasPower, false, 'counter/SoC-only messages must not refresh active power');
  assert.equal(meterNotes[3].flags.hasNonZeroActualFlow, false);
  assert.equal(socNotes.length, 1);

  const before = writes.filter((entry) => entry.id === `${station}.meterValues.SoC`).length;
  await applyMeterValues(ctx, station, 1, 1, [{
    timestamp,
    sampledValue: [{ measurand: 'SoC', value: 57, unitOfMeasure: { unit: '%' } }],
  }], 'ocpp2.1');
  const after = writes.filter((entry) => entry.id === `${station}.meterValues.SoC`).length;
  assert.equal(after, before + 1, 'unchanged values must still be written to refresh their timestamp');
  assert.equal(meterNotes.length, 5, 'SoC-only MeterValues still refresh general meter age');
  assert.equal(socNotes.length, 2, 'SoC freshness is tracked independently from power/current freshness');
});

test('empty or malformed MeterValues do not falsely mark telemetry as fresh', async () => {
  const { ctx, meterNotes } = createMeterContext();
  await applyMeterValues(ctx, 'DC_02', 1, 1, [{
    timestamp: '2026-08-12T08:00:00.000Z',
    sampledValue: [{ measurand: 'Power.Active.Import', value: 'not-a-number', unitOfMeasure: { unit: 'W' } }],
  }], 'ocpp2.1');
  assert.equal(meterNotes.length, 0);
});

test('current or reactive power cannot falsely mark EOS active-import power as fresh', async () => {
  const { ctx, meterNotes } = createMeterContext();
  await applyMeterValues(ctx, 'DC_03', 1, 1, [{
    timestamp: '2026-08-12T08:00:00.000Z',
    sampledValue: [
      { measurand: 'Current.Import', value: 30, unitOfMeasure: { unit: 'A' } },
      { measurand: 'Power.Reactive.Import', value: 100, unitOfMeasure: { unit: 'var' } },
    ],
  }], 'ocpp2.1');
  assert.equal(meterNotes.length, 1);
  assert.equal(meterNotes[0].flags.hasPower, false);
  assert.equal(meterNotes[0].flags.hasCurrent, true);
  assert.equal(meterNotes[0].flags.hasNonZeroActualFlow, true);
});

test('OCPP 1.6 SampledValue defaults are mapped to the energy register and Wh', async () => {
  const { ctx, writes, meterNotes } = createMeterContext();
  await applyMeterValues(ctx, 'AC_16', 1, 1, [{
    timestamp: '2026-08-12T08:00:00.000Z',
    sampledValue: [{ value: '1234' }],
  }], 'ocpp1.6');
  assert.equal(lastWrite(writes, 'AC_16.meterValues.Energy_Active_Import_Register').val, 1234);
  assert.equal(lastWrite(writes, 'AC_16.meterValues.Energy_Active_Import_Register_kWh').val, 1.234);
  assert.equal(meterNotes.length, 1, 'a valid counter updates general MeterValues freshness');
  assert.equal(meterNotes[0].flags.hasPower, false, 'energy counters are not active-power freshness');
});

test('OCPP 2.x SampledValue defaults are mapped to the energy register and Wh', async () => {
  for (const protocol of ['ocpp2.0.1', 'ocpp2.1']) {
    const { ctx, writes, meterNotes } = createMeterContext();
    const station = protocol === 'ocpp2.0.1' ? 'DC_201' : 'DC_21';
    await applyMeterValues(ctx, station, 1, 1, [{
      timestamp: '2026-08-12T08:00:00.000Z',
      sampledValue: [{ value: 2500 }],
    }], protocol);
    assert.equal(lastWrite(writes, `${station}.meterValues.Energy_Active_Import_Register`).val, 2500);
    assert.equal(lastWrite(writes, `${station}.meterValues.Energy_Active_Import_Register_kWh`).val, 2.5);
    assert.equal(meterNotes.length, 1);
    assert.equal(meterNotes[0].flags.hasPower, false);
  }
});

test('schema fallback responses fail closed instead of reporting unsupported work as accepted', () => {
  const auto201 = createAutoResponder('ocpp2.0.1');
  const auto21 = createAutoResponder('ocpp2.1');
  assert.equal(auto201('TriggerMessage', { preferFailure: true }).status, 'NotImplemented');
  assert.equal(auto21('RequestStartTransaction', { preferFailure: true }).status, 'Rejected');
});

class FakeClient {
  constructor(protocol) {
    this.protocol = protocol;
    this.identity = 'station';
    this.stateIdentity = 'station';
    this.handlers = new Map();
    this.wildcard = undefined;
  }

  handle(method, handler) {
    if (typeof method === 'function') this.wildcard = method;
    else this.handlers.set(method, handler);
  }
}

function registrationContext() {
  return {
    config: { heartbeatIntervalSec: 300 },
    log: { debug() {}, warn() {} },
    states: {},
    runtime: {},
    dp: {},
    dm: {},
  };
}

test('all supported protocol versions register the critical telemetry handlers and a catch-all', () => {
  const clients = [
    ['ocpp1.6', register16, ['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues', 'StartTransaction', 'StopTransaction']],
    ['ocpp2.0.1', register201, ['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues', 'TransactionEvent', 'NotifyEVChargingNeeds', 'NotifyReport']],
    ['ocpp2.1', register21, ['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues', 'TransactionEvent', 'NotifyEVChargingNeeds', 'NotifyReport']],
  ];
  for (const [protocol, register, expected] of clients) {
    const client = new FakeClient(protocol);
    register(client, registrationContext());
    for (const method of expected) assert.equal(client.handlers.has(method), true, `${protocol} missing ${method}`);
    assert.equal(typeof client.wildcard, 'function', `${protocol} missing catch-all handler`);
  }
});

test('OCPP 1.6 keeps concurrent transactions mapped to their original connector', async () => {
  const client = new FakeClient('ocpp1.6');
  const events = [];
  const writes = [];
  const ctx = {
    config: { heartbeatIntervalSec: 300 },
    log: { debug() {}, warn() {} },
    setStateFreshAsync: async (id, val, ack, category) => writes.push({ id, val, ack, category }),
    states: {
      async pushTransactionEvent(identity, event) { events.push({ identity, ...event }); },
    },
    runtime: { async noteMessage() {} },
    dp: { async capture() {} },
  };
  register16(client, ctx);

  const first = await client.handlers.get('StartTransaction')({
    params: { connectorId: 1, idTag: 'RFID-1', meterStart: 1000, timestamp: '2026-08-12T08:00:00.000Z' },
  });
  const second = await client.handlers.get('StartTransaction')({
    params: { connectorId: 2, idTag: 'RFID-2', meterStart: 2000, timestamp: '2026-08-12T08:01:00.000Z' },
  });

  assert.notEqual(first.transactionId, second.transactionId);
  assert.equal(client._transactions.size, 2);

  await client.handlers.get('StopTransaction')({
    params: { transactionId: first.transactionId, meterStop: 1500, reason: 'Local' },
  });

  const stop = events.find((event) => event.type === 'Stop');
  assert.equal(stop.connectorId, 1, 'the first transaction must not be assigned to the last active connector');
  assert.equal(stop.idTag, 'RFID-1');
  assert.equal(client._transactions.has(String(first.transactionId)), false);
  assert.equal(client._transactions.has(String(second.transactionId)), true);
  assert.equal(lastWrite(writes, 'station.evse.1.connector.1.meter.lastKWh').val, 1);
  assert.equal(lastWrite(writes, 'station.evse.1.connector.2.meter.lastKWh').val, 2);
});

test('NotifyEVChargingNeeds maps DC SoC and charging needs without falsifying meter freshness', async () => {
  const client = new FakeClient('ocpp2.1');
  const writes = [];
  const socNotes = [];
  const ensured = [];
  const ctx = {
    config: { heartbeatIntervalSec: 300 },
    log: { debug() {}, warn() {} },
    setStateFreshAsync: async (id, val, ack, category) => writes.push({ id, val, ack, category }),
    states: {
      ensureStructure: async (...args) => ensured.push(args),
      ensureAggState: async (identity, key) => `${identity}.meterValues.${key}`,
    },
    runtime: {
      async noteMessage() {},
      async noteSoc(identity, timestamp) { socNotes.push({ identity, timestamp }); },
    },
    dp: { async capture() {} },
    dm: {},
  };
  register21(client, ctx);

  const response = await client.handlers.get('NotifyEVChargingNeeds')({
    params: {
      evseId: 2,
      maxScheduleTuples: 8,
      timestamp: '2099-01-01T00:00:00.000Z',
      chargingNeeds: {
        requestedEnergyTransfer: 'DC',
        departureTime: '2026-08-12T12:00:00.000Z',
        dcChargingParameters: {
          stateOfCharge: '62',
          fullSoC: 100,
          bulkSoC: 80,
          energyAmount: 25000,
          evEnergyCapacity: 80000,
          evMaxPower: 120000,
          evMaxCurrent: 300,
          evMaxVoltage: 920,
        },
        v2xChargingParameters: { targetSoC: 85 },
      },
    },
  });

  assert.deepEqual(response, { status: 'Accepted' });
  assert.deepEqual(ensured, [['station', 2, 1]]);
  assert.equal(lastWrite(writes, 'station.evChargingNeeds.stateOfCharge').val, 62);
  assert.equal(lastWrite(writes, 'station.evChargingNeeds.targetSoC').val, 85);
  assert.equal(lastWrite(writes, 'station.evChargingNeeds.energyAmountWh').val, 25000);
  assert.equal(lastWrite(writes, 'station.meterValues.SoC').val, 62);
  assert.equal(socNotes.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(ctx.runtime, 'noteMeterValue'), false);
});
