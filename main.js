'use strict';
const utils = require('@iobroker/adapter-core');
const { OcppRpcServer } = require('./ocpp/server');
const {
  sanitizeStationIdentity,
  heartbeatTimeoutMs,
  commandTimeoutMs,
  isTriggerAccepted,
  isTriggerUnsupported,
  isTriggerRejected,
  buildTriggerPayload,
  isChargingState,
  statusImpliesZero,
  chargingStateImpliesZero,
  isRealtimeMetricId,
  isCounterMetricId,
  isActualPowerOrCurrentId,
  dataFreshForEos,
  selectCachedStatesForRepublish,
  takeRotatingItems,
  parseDeviceModelValue,
} = require('./ocpp/freshness');

class NexoWattOcppAdapter extends utils.Adapter {
  constructor(options) {
    super({ ...options, name: 'ocpp21' });
    this.server = null;
    this.runtimeIndex = new Map();

    // Runtime caches to avoid excessive object creation overhead
    this._dpObjCache = new Set();
    this._dpCounts = new Map();
    this._aliasDone = new Set();
    this._dmIndex = new Map(); // stateId -> { protocol, component, variable, attributeType }
    this._rawToStateIdentity = new Map();
    this._stateToRawIdentity = new Map();
    this._freshStateCache = new Map(); // identity -> Map(stateId, { val, ack, category, updatedAt })
    this._phaseMetricCache = new Map();
    this._identityStructureReady = new Set();
    this._connectorStructureReady = new Set();
    this._watchdogTimer = null;
    this._watchdogRunning = false;
    this._shuttingDown = false;

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

  resolveStationIdentity(rawIdentity) {
    const raw = String(rawIdentity ?? '').trim();
    if (this._rawToStateIdentity.has(raw)) return this._rawToStateIdentity.get(raw);
    let stateId = sanitizeStationIdentity(raw);
    const existingRaw = this._stateToRawIdentity.get(stateId);
    if (existingRaw && existingRaw !== raw) {
      let suffix = 2;
      const base = stateId;
      while (this._stateToRawIdentity.has(`${base}_${suffix}`)) suffix++;
      stateId = `${base}_${suffix}`;
    }
    this._rawToStateIdentity.set(raw, stateId);
    this._stateToRawIdentity.set(stateId, raw);
    return stateId;
  }

  _identityFromStateId(id) {
    const rel = this._stripNs(String(id || ''));
    return rel.split('.')[0] || '';
  }

  _cacheFreshState(id, val, ack, category) {
    if (!category || ['payload', 'health', 'control', 'dm'].includes(category)) return;
    const rel = this._stripNs(id);
    const identity = this._identityFromStateId(rel);
    if (!identity) return;
    if (!this._freshStateCache.has(identity)) this._freshStateCache.set(identity, new Map());
    this._freshStateCache.get(identity).set(rel, { val, ack: !!ack, category, updatedAt: Date.now() });
  }

  async _setStateFreshAsync(id, val, ack = true, category = 'status') {
    const rel = this._stripNs(id);
    await this.setStateAsync(rel, { val, ack: !!ack });
    this._cacheFreshState(rel, val, ack, category);
  }

  _metricCategoryFromId(id) {
    if (isCounterMetricId(id)) return 'counter';
    if (/(?:^|\.)(?:SoC|soc)(?:_|\.|$)/.test(String(id || ''))) return 'soc';
    if (isRealtimeMetricId(id)) return 'realtime';
    return 'status';
  }

  _indexClient(identity, proto, client, rawIdentity) {
    const now = Date.now();
    const old = this.runtimeIndex.get(identity);
    if (old && old.client !== client) {
      this.log.warn(`Charging station identity ${rawIdentity || identity} connected again; the newer connection replaces the old runtime session.`);
      if (old.client && typeof old.client.close === 'function') {
        Promise.resolve(old.client.close({ code: 1008, reason: 'Superseded by a newer connection' })).catch(() => undefined);
      }
    }
    // Never carry realtime timestamps or phase fragments across OCPP sessions.
    this._freshStateCache.delete(identity);
    for (const key of [...this._phaseMetricCache.keys()]) if (key.startsWith(`${identity}|`)) this._phaseMetricCache.delete(key);
    this.runtimeIndex.set(identity, {
      proto,
      client,
      rawIdentity: rawIdentity || identity,
      connectedAt: now,
      socketConnected: true,
      lastMessageAt: now,
      lastAction: 'Connect',
      lastHeartbeatAt: 0,
      lastMeterAt: 0,
      lastPowerAt: 0,
      lastExportPowerAt: 0,
      lastCurrentAt: 0,
      lastSocAt: 0,
      lastStatusAt: 0,
      heartbeatIntervalSec: Math.max(10, Number(this.config.heartbeatIntervalSec) || 300),
      connectors: new Set(['1:1']),
      statuses: new Map(),
      transactionActive: false,
      chargingState: '',
      refreshInFlight: false,
      nextRefreshAt: now,
      triggerSupport: { MeterValues: 'unknown', StatusNotification: 'unknown' },
      triggerRetryAt: { MeterValues: 0, StatusNotification: 0 },
      lastRefreshAttemptAt: 0,
      lastRefreshSuccessAt: 0,
      lastRefreshError: '',
      lastStateRepublishAt: 0,
      republishCursor: 0,
      refreshConnectorCursor: 0,
      safeZeroAt: 0,
      safeZeroReason: '',
      booted: false,
    });
  }

  _unindexClient(identity, client) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry || (client && entry.client !== client)) return false;
    this.runtimeIndex.delete(identity);
    return true;
  }

  async _noteMessage(identity, action) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry) return;
    const now = Date.now();
    entry.lastMessageAt = now;
    entry.lastAction = String(action || '');
    await this.ensureStructure(identity);
    await this._setStateFreshAsync(`${identity}.health.lastSeenMs`, now, true, 'health');
    await this._setStateFreshAsync(`${identity}.health.lastSeen`, new Date(now).toISOString(), true, 'health');
    await this._setStateFreshAsync(`${identity}.health.lastAction`, entry.lastAction, true, 'health');
  }

  async _noteBoot(identity, intervalSec) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry) return;
    const now = Date.now();
    entry.booted = true;
    entry.heartbeatIntervalSec = Math.max(10, Number(intervalSec) || entry.heartbeatIntervalSec || 300);
    // BootNotification proves OCPP application-level liveness and starts the heartbeat grace period.
    entry.lastHeartbeatAt = now;
    entry.nextRefreshAt = now;
    await this.ensureStructure(identity);
    await this._setStateFreshAsync(`${identity}.health.lastBoot`, new Date(now).toISOString(), true, 'health');
  }

  async _noteHeartbeat(identity, timestamp) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry) return;
    const parsed = Date.parse(timestamp);
    const now = Number.isFinite(parsed) ? parsed : Date.now();
    entry.lastHeartbeatAt = now;
    entry.lastMessageAt = Math.max(entry.lastMessageAt || 0, now);
    entry.nextRefreshAt = Math.min(entry.nextRefreshAt || now, now);
    await this.ensureStructure(identity);
    const iso = new Date(now).toISOString();
    await this._setStateFreshAsync(`${identity}.info.lastHeartbeat`, iso, true, 'status');
    await this._setStateFreshAsync(`${identity}.health.heartbeat`, iso, true, 'health');
    await this._setStateFreshAsync(`${identity}.health.lastHeartbeatMs`, now, true, 'health');
  }

  async _noteStatus(identity, evseId, connectorId, status) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry) return;
    const now = Date.now();
    entry.lastStatusAt = now;
    entry.connectors.add(`${Math.max(0, Number(evseId) || 0)}:${Math.max(0, Number(connectorId) || 0)}`);
    entry.statuses.set(`${evseId}:${connectorId}`, String(status || ''));
    if (isChargingState(status)) {
      entry.safeZeroAt = 0;
      entry.safeZeroReason = '';
    }
    if (this.config.zeroPowerWhenIdle !== false && statusImpliesZero(entry.proto, status)) {
      await this._zeroActualFlow(identity, `status:${status}`, evseId, connectorId);
    }
  }

  async _noteMeterValue(identity, evseId, connectorId, timestamp, flags = {}) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry) return;
    // Freshness is based on local receipt time. A station clock can be wrong,
    // in the future or far in the past and must not falsify EOS data quality.
    const now = Date.now();
    entry.lastMeterAt = Math.max(entry.lastMeterAt || 0, now);
    if (flags.hasPower) entry.lastPowerAt = Math.max(entry.lastPowerAt || 0, now);
    if (flags.hasExportPower) entry.lastExportPowerAt = Math.max(entry.lastExportPowerAt || 0, now);
    if (flags.hasCurrent) entry.lastCurrentAt = Math.max(entry.lastCurrentAt || 0, now);
    entry.connectors.add(`${Math.max(0, Number(evseId) || 0)}:${Math.max(0, Number(connectorId) || 0)}`);
    // A valid, non-zero actual-flow sample contradicts a previously derived
    // idle zero. Counter-only, SoC-only or zero-valued samples do not: an
    // unchanged Available/Idle protocol state remains authoritative while the
    // station is online.
    if (flags.hasNonZeroActualFlow) {
      entry.safeZeroAt = 0;
      entry.safeZeroReason = '';
    }
    await this.ensureStructure(identity, evseId, connectorId);
    await this._setStateFreshAsync(`${identity}.health.lastMeterValue`, new Date(entry.lastMeterAt).toISOString(), true, 'health');
    if (flags.hasPower) await this._setStateFreshAsync(`${identity}.health.lastPowerValue`, new Date(entry.lastPowerAt).toISOString(), true, 'health');
    if (flags.hasExportPower) await this._setStateFreshAsync(`${identity}.health.lastExportPowerValue`, new Date(entry.lastExportPowerAt).toISOString(), true, 'health');
    if (flags.hasCurrent) await this._setStateFreshAsync(`${identity}.health.lastCurrentValue`, new Date(entry.lastCurrentAt).toISOString(), true, 'health');
  }

  async _noteSoc(identity, timestamp) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry) return;
    // As with meter freshness, use receipt time rather than the EV/station
    // timestamp so clock skew cannot falsify health.socFresh.
    const now = Date.now();
    entry.lastSocAt = Math.max(entry.lastSocAt || 0, now);
    await this.ensureStructure(identity);
    await this._setStateFreshAsync(`${identity}.health.lastSoc`, new Date(entry.lastSocAt).toISOString(), true, 'health');
  }

  _recordPhaseMetric(identity, evseId, connectorId, measurand, phase, value, unit, ts) {
    const canonicalPhase = String(phase || '').replace(/N$/i, '').toUpperCase();
    const key = `${identity}|${evseId}|${connectorId}|${measurand}`;
    if (!this._phaseMetricCache.has(key)) this._phaseMetricCache.set(key, new Map());
    this._phaseMetricCache.get(key).set(canonicalPhase, { value: Number(value), unit: unit || '', ts: Number(ts) || Date.now() });
  }

  _getPhaseMetricTotal(identity, evseId, connectorId, measurand) {
    const key = `${identity}|${evseId}|${connectorId}|${measurand}`;
    const values = this._phaseMetricCache.get(key);
    if (!values) return undefined;
    const maxAgeMs = Math.max(15, Number(this.config.telemetryMaxAgeSec) || 90) * 1000;
    const cutoff = Date.now() - maxAgeMs;
    let total = 0;
    let count = 0;
    let unit = '';
    for (const [phase, sample] of values.entries()) {
      if (!sample || sample.ts < cutoff || !Number.isFinite(sample.value)) {
        values.delete(phase);
        continue;
      }
      total += sample.value;
      count++;
      unit = unit || sample.unit || '';
    }
    return count ? { value: total, unit, phaseCount: count } : undefined;
  }

  async _noteTransaction(identity, evt) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry) return;
    if (evt.type === 'Start') entry.transactionActive = true;
    if (evt.type === 'Stop') entry.transactionActive = false;
    if (evt.chargingState !== undefined) entry.chargingState = String(evt.chargingState || '');
    if (evt.type === 'Start' || (isChargingState(evt.chargingState) && !chargingStateImpliesZero(evt.chargingState))) {
      entry.safeZeroAt = 0;
      entry.safeZeroReason = '';
    }
    if (evt.evseId !== undefined || evt.connectorId !== undefined) {
      entry.connectors.add(`${Math.max(0, Number(evt.evseId) || 1)}:${Math.max(0, Number(evt.connectorId) || 1)}`);
    }
    if (this.config.zeroPowerWhenIdle !== false && (evt.type === 'Stop' || chargingStateImpliesZero(evt.chargingState))) {
      await this._zeroActualFlow(identity, evt.type === 'Stop' ? 'transaction-ended' : `charging-state:${evt.chargingState}`, evt.evseId, evt.connectorId);
    }
  }

  async _zeroActualFlow(identity, reason, evseId, connectorId) {
    await this.ensureStructure(identity, evseId || 1, connectorId || 1);
    const now = Date.now();
    const entry = this.runtimeIndex.get(identity);
    const cache = this._freshStateCache.get(identity);
    const ids = new Set([
      `${identity}.meterValues.Power_Active_Import`,
      `${identity}.meterValues.Power_Active_Export`,
      `${identity}.meterValues.Current_Import`,
      `${identity}.meterValues.Current_Export`,
    ]);
    if (cache) {
      for (const stateId of cache.keys()) if (isActualPowerOrCurrentId(stateId)) ids.add(stateId);
    }
    if (evseId !== undefined && connectorId !== undefined) {
      ids.add(`${identity}.evse.${evseId}.connector.${connectorId}.meter.Power.Active.Import`);
      ids.add(`${identity}.evse.${evseId}.connector.${connectorId}.meter.Current.Import`);
    }
    for (const stateId of ids) {
      const unit = stateId.includes('Current') ? 'A' : 'W';
      if (stateId.includes('.meterValues.')) await this.ensureAgg(identity, stateId.split('.meterValues.')[1], unit);
      else if (stateId.includes('.meter.')) {
        const m = stateId.match(/^([^\.]+)\.evse\.(\d+)\.connector\.(\d+)\.meter\.(.+)$/);
        if (m) await this.ensureMetric(m[1], Number(m[2]), Number(m[3]), m[4], unit);
      }
      await this._setStateFreshAsync(stateId, 0, true, 'safeZero');
    }
    for (const key of [...this._phaseMetricCache.keys()]) if (key.startsWith(`${identity}|`)) this._phaseMetricCache.delete(key);
    if (entry) {
      // Safe zero is protocol-derived, not a received MeterValues sample.
      entry.safeZeroAt = now;
      entry.safeZeroReason = reason;
    }
    await this._setStateFreshAsync(`${identity}.health.safeZeroApplied`, true, true, 'health');
    await this._setStateFreshAsync(`${identity}.health.safeZeroReason`, reason, true, 'health');
  }

  async _touchCachedStates(identity, safeZero, now = Date.now(), cursor = 0) {
    const cache = this._freshStateCache.get(identity);
    if (!cache || cache.size === 0) return 0;
    const maxStates = Math.max(25, Number(this.config.maxRepublishedStates) || 250);
    const selection = selectCachedStatesForRepublish(cache.entries(), {
      cursor,
      limit: maxStates,
      now,
      telemetryMaxAgeSec: this.config.telemetryMaxAgeSec,
      socMaxAgeSec: this.config.socMaxAgeSec,
      safeZero,
    });
    for (const [stateId, item] of selection.entries) {
      await this.setStateAsync(stateId, { val: item.val, ack: item.ack });
    }
    return selection.nextCursor;
  }

  async _callClient(identity, method, payload, options = {}) {
    const entry = this.runtimeIndex.get(identity);
    if (!entry || !entry.client) throw new Error(`No connected charging station for ${identity}`);
    const timeoutMs = commandTimeoutMs(this.config.callTimeoutSec);
    if (options.capture !== false) {
      try { await this.captureOcppPayload(identity, entry.proto, 'out', method, payload); } catch (e) { /* capture must not block control */ }
    }
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timeout after ${timeoutMs} ms`)), timeoutMs);
      });
      const response = await Promise.race([entry.client.call(method, payload), timeout]);
      if (options.capture !== false) {
        try { await this.captureOcppPayload(identity, entry.proto, 'out', `${method}Response`, response); } catch (e) { /* ignore */ }
      }
      return response;
    } catch (e) {
      if (options.capture !== false) {
        try { await this.captureOcppPayload(identity, entry.proto, 'out', `${method}Error`, { error: String(e && e.message || e) }); } catch (err) { /* ignore */ }
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _assertCallAccepted(method, response) {
    if (!response || typeof response !== 'object' || typeof response.status !== 'string') return response;
    const status = response.status.trim();
    const accepted = new Set(['accepted', 'scheduled', 'rebootrequired', 'ok']);
    if (!accepted.has(status.toLowerCase())) throw new Error(`${method} returned status ${status}`);
    return response;
  }

  _stringifyControlValue(value) {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  async _recordControlResult(identity, method, response, error) {
    await this.ensureStructure(identity);
    const now = new Date().toISOString();
    const errorText = error ? String(error && error.message || error) : '';
    await this._setStateFreshAsync(`${identity}.control.lastCommand`, String(method || ''), true, 'control');
    await this._setStateFreshAsync(`${identity}.control.lastCommandAt`, now, true, 'control');
    await this._setStateFreshAsync(`${identity}.control.lastResponse`, errorText ? '' : this._stringifyControlValue(response), true, 'control');
    await this._setStateFreshAsync(`${identity}.control.lastError`, errorText, true, 'control');
    await this._setStateFreshAsync(`${identity}.control.lastSuccess`, !errorText, true, 'control');
  }

  _buildChargingProfileCall(protocol, limit, rateUnit, phases) {
    const chargingProfileId = Math.floor(Math.random() * 0x7ffffffe) + 1;
    if (protocol === 'ocpp1.6') {
      return {
        method: 'SetChargingProfile',
        payload: {
          connectorId: 1,
          csChargingProfiles: {
            chargingProfileId,
            stackLevel: 0,
            chargingProfilePurpose: 'TxDefaultProfile',
            chargingProfileKind: 'Absolute',
            chargingSchedule: {
              startSchedule: new Date().toISOString(),
              chargingRateUnit: rateUnit,
              chargingSchedulePeriod: [{ startPeriod: 0, limit, numberPhases: phases }],
            },
          },
        },
      };
    }
    return {
      method: 'SetChargingProfile',
      payload: {
        evseId: 0,
        chargingProfile: {
          id: chargingProfileId,
          stackLevel: 0,
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [{
            id: Math.floor(Math.random() * 0x7ffffffe) + 1,
            startSchedule: new Date().toISOString(),
            chargingRateUnit: rateUnit,
            chargingSchedulePeriod: [{ startPeriod: 0, limit, numberPhases: phases }],
          }],
        },
      },
    };
  }

  async _requestFreshData(identity, entry) {
    if (!entry || !entry.client || entry.refreshInFlight || this.config.activeRefresh === false) return;
    const now = Date.now();
    if (now < (entry.nextRefreshAt || 0)) return;
    entry.refreshInFlight = true;
    entry.lastRefreshAttemptAt = now;
    entry.nextRefreshAt = now + Math.max(5, Number(this.config.activeRefreshIntervalSec) || 15) * 1000;
    const connectorSelection = takeRotatingItems(
      entry.connectors,
      entry.refreshConnectorCursor,
      Math.max(1, Number(this.config.maxConnectorsPerRefresh) || 8),
    );
    const connectors = connectorSelection.items;
    entry.refreshConnectorCursor = connectorSelection.nextCursor;
    let accepted = 0;
    let attempted = 0;
    let skippedFresh = 0;
    let skippedBackoff = 0;
    const errors = [];
    try {
      await this._setStateFreshAsync(`${identity}.health.refreshLastAttempt`, new Date(now).toISOString(), true, 'health');
      for (const key of connectors.length ? connectors : ['1:1']) {
        const [evseId, connectorId] = key.split(':').map(Number);
        for (const requestedMessage of ['MeterValues', 'StatusNotification']) {
          if (requestedMessage === 'MeterValues' && this.config.refreshMeterValues === false) continue;
          if (requestedMessage === 'StatusNotification' && this.config.refreshStatusNotification === false) continue;
          // MeterValues refresh is driven by active-import power freshness,
          // not by unrelated counters, SoC or temperature samples.
          const freshAt = requestedMessage === 'MeterValues' ? entry.lastPowerAt : entry.lastStatusAt;
          const refreshIntervalMs = Math.max(5, Number(this.config.activeRefreshIntervalSec) || 15) * 1000;
          if (freshAt && now - freshAt < Math.max(3000, refreshIntervalMs * 0.8)) {
            skippedFresh++;
            continue;
          }
          if (entry.triggerRetryAt[requestedMessage] && now < entry.triggerRetryAt[requestedMessage]) {
            skippedBackoff++;
            continue;
          }
          attempted++;
          try {
            const response = await this._callClient(identity, 'TriggerMessage', buildTriggerPayload(entry.proto, requestedMessage, evseId, connectorId));
            const status = String(response && response.status || 'Unknown');
            entry.triggerSupport[requestedMessage] = status;
            if (isTriggerAccepted(response)) {
              accepted++;
              entry.triggerRetryAt[requestedMessage] = 0;
            } else if (isTriggerUnsupported(response)) {
              entry.triggerRetryAt[requestedMessage] = now + 6 * 60 * 60 * 1000;
            } else if (isTriggerRejected(response)) {
              entry.triggerRetryAt[requestedMessage] = now + 10 * 60 * 1000;
            } else {
              entry.triggerRetryAt[requestedMessage] = now + 10 * 60 * 1000;
              errors.push(`${requestedMessage}: unexpected status ${status}`);
            }
          } catch (e) {
            entry.triggerSupport[requestedMessage] = 'error';
            entry.triggerRetryAt[requestedMessage] = now + 10 * 60 * 1000;
            errors.push(`${requestedMessage}: ${e && e.message || e}`);
          }
        }
      }
      if (accepted > 0) entry.lastRefreshSuccessAt = Date.now();
      entry.lastRefreshError = errors.join('; ');
      let refreshStatus = 'not-run';
      if (accepted > 0) refreshStatus = 'requested';
      else if (errors.length) refreshStatus = 'error/backoff';
      else if (attempted === 0 && skippedFresh > 0) refreshStatus = 'fresh-no-request';
      else if (attempted === 0 && skippedBackoff > 0) refreshStatus = 'backoff';
      else if (attempted > 0) refreshStatus = 'not-accepted/backoff';
      await this._setStateFreshAsync(`${identity}.health.refreshStatus`, refreshStatus, true, 'health');
      await this._setStateFreshAsync(`${identity}.health.refreshSupport`, JSON.stringify(entry.triggerSupport), true, 'health');
      await this._setStateFreshAsync(`${identity}.health.refreshLastError`, entry.lastRefreshError, true, 'health');
      if (entry.lastRefreshSuccessAt) await this._setStateFreshAsync(`${identity}.health.refreshLastSuccess`, new Date(entry.lastRefreshSuccessAt).toISOString(), true, 'health');
    } finally {
      entry.refreshInFlight = false;
    }
  }

  async _watchdogCycle() {
    if (this._watchdogRunning || this._shuttingDown) return;
    this._watchdogRunning = true;
    try {
      const now = Date.now();
      for (const [identity, entry] of this.runtimeIndex.entries()) {
        await this.ensureStructure(identity);
        const timeoutMs = heartbeatTimeoutMs(entry.heartbeatIntervalSec, this.config.heartbeatTimeoutFactor);
        const lastActivityAt = Math.max(entry.connectedAt || 0, entry.lastMessageAt || 0, entry.lastHeartbeatAt || 0);
        const messageAgeSec = entry.lastMessageAt ? Math.max(0, (now - entry.lastMessageAt) / 1000) : -1;
        const heartbeatAgeSec = entry.lastHeartbeatAt ? Math.max(0, (now - entry.lastHeartbeatAt) / 1000) : -1;
        const meterAgeSec = entry.lastMeterAt ? Math.max(0, (now - entry.lastMeterAt) / 1000) : -1;
        const powerAgeSec = entry.lastPowerAt ? Math.max(0, (now - entry.lastPowerAt) / 1000) : -1;
        const exportPowerAgeSec = entry.lastExportPowerAt ? Math.max(0, (now - entry.lastExportPowerAt) / 1000) : -1;
        const currentAgeSec = entry.lastCurrentAt ? Math.max(0, (now - entry.lastCurrentAt) / 1000) : -1;
        const statusAgeSec = entry.lastStatusAt ? Math.max(0, (now - entry.lastStatusAt) / 1000) : -1;
        const socAgeSec = entry.lastSocAt ? Math.max(0, (now - entry.lastSocAt) / 1000) : -1;
        const socketConnected = !!entry.socketConnected;
        const online = socketConnected && now - lastActivityAt <= timeoutMs;
        const heartbeatAlive = socketConnected && entry.lastHeartbeatAt > 0 && now - entry.lastHeartbeatAt <= timeoutMs;
        const telemetryMaxAgeSec = Math.max(15, Number(this.config.telemetryMaxAgeSec) || 90);
        const meterFresh = entry.lastMeterAt > 0 && meterAgeSec <= telemetryMaxAgeSec;
        const powerFresh = entry.lastPowerAt > 0 && powerAgeSec <= telemetryMaxAgeSec;
        const exportPowerFresh = entry.lastExportPowerAt > 0 && exportPowerAgeSec <= telemetryMaxAgeSec;
        const currentFresh = entry.lastCurrentAt > 0 && currentAgeSec <= telemetryMaxAgeSec;
        const socFresh = entry.lastSocAt > 0 && socAgeSec <= Math.max(30, Number(this.config.socMaxAgeSec) || 300);
        // safeZeroAt is cleared immediately by a charging event or a
        // contradictory non-zero actual-flow sample. Therefore a previously
        // confirmed idle/end state remains valid across later counter, SoC or
        // zero-only MeterValues messages.
        const safeZero = entry.safeZeroAt > 0;
        // EOS data freshness is tied to the canonical active-import power or a
        // protocol-derived safe zero. Heartbeat/current/reactive power alone do
        // not make an old power datapoint suitable for closed-loop control.
        const dataFresh = dataFreshForEos(online, powerFresh, safeZero);
        let staleReason = '';
        if (!socketConnected) staleReason = 'socket-disconnected';
        else if (!online) staleReason = 'no-ocpp-activity';
        else if (!dataFresh && exportPowerFresh) staleReason = 'export-power-only-no-import-power';
        else if (!dataFresh && !entry.lastPowerAt) staleReason = 'awaiting-power-or-idle-status';
        else if (!dataFresh) staleReason = 'power-values-stale';

        await this._setStateFreshAsync(`${identity}.info.connection`, online, true, 'status');
        await this._setStateFreshAsync(`${identity}.info.socketConnected`, socketConnected, true, 'status');
        await this._setStateFreshAsync(`${identity}.health.online`, online, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.socketConnected`, socketConnected, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.heartbeatAlive`, heartbeatAlive, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.meterFresh`, meterFresh, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.powerFresh`, powerFresh, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.exportPowerFresh`, exportPowerFresh, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.currentFresh`, currentFresh, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.dataFresh`, dataFresh, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.socFresh`, socFresh, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.staleReason`, staleReason, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.messageAgeSec`, Math.round(messageAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.heartbeatAgeSec`, Math.round(heartbeatAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.meterAgeSec`, Math.round(meterAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.powerAgeSec`, Math.round(powerAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.exportPowerAgeSec`, Math.round(exportPowerAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.currentAgeSec`, Math.round(currentAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.statusAgeSec`, Math.round(statusAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.socAgeSec`, Math.round(socAgeSec), true, 'health');
        await this._setStateFreshAsync(`${identity}.health.safeZeroApplied`, safeZero, true, 'health');
        await this._setStateFreshAsync(`${identity}.health.safeZeroReason`, entry.safeZeroReason || '', true, 'health');

        const republishMs = Math.max(5, Number(this.config.stateRefreshIntervalSec) || 10) * 1000;
        if (online && now - (entry.lastStateRepublishAt || 0) >= republishMs) {
          entry.republishCursor = await this._touchCachedStates(identity, safeZero, now, entry.republishCursor || 0);
          entry.lastStateRepublishAt = now;
          await this._setStateFreshAsync(`${identity}.health.lastRepublish`, new Date(now).toISOString(), true, 'health');
        }
        if (online && entry.booted) {
          // Active refresh may wait for a slow or non-compliant station. Do not
          // block health processing for this or any other connected station.
          this._requestFreshData(identity, entry).catch((e) => {
            this.log.warn(`Active refresh failed for ${identity}: ${e && e.message || e}`);
          });
        }
      }
    } catch (e) {
      this.log.warn(`NexoWatt OCPP freshness watchdog failed: ${e && e.stack || e}`);
    } finally {
      this._watchdogRunning = false;
    }
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
    await this._setStateFreshAsync(`${base}.raw`, raw, true, 'payload');
    await this._setStateFreshAsync(`${base}.ts`, now, true, 'payload');
    await this._setStateFreshAsync(`${base}.count`, cnt, true, 'payload');

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

      await this._setStateFreshAsync(stateId, val, true, 'payload');
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
    return parseDeviceModelValue(valueStr, dataType);
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
        if (def.val !== undefined) {
          const value = def.type === 'number' ? Number(def.val) : def.val;
          if (def.type !== 'number' || Number.isFinite(value)) await this._setStateFreshAsync(sid, value, true, 'dm');
        }
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
            write: !constant && String(mut) !== 'ReadOnly',
            unit: unit || undefined,
          },
          native: { ocppDm: meta },
        });
        // NotifyReport can change mutability/constant metadata. Repair objects
        // created by an older adapter version instead of keeping unsafe write access.
        if (typeof this.extendObjectAsync === 'function') {
          await this.extendObjectAsync(valueId, {
            common: {
              type: parsed.type,
              role: parsed.type === 'number' ? 'value' : parsed.type === 'boolean' ? 'indicator' : this._looksLikeIsoTime(parsed.val) ? 'value.time' : 'text',
              read: true,
              write: !constant && String(mut) !== 'ReadOnly',
              unit: unit || undefined,
            },
            native: { ocppDm: meta },
          });
        }
        await this._setObjectNotExistsCached(`${base}.${this._sanitizeSeg(attrType)}.mutability`, { type: 'state', common: { name: 'mutability', type: 'string', role: 'text', read: true, write: false }, native: {} });
        await this._setObjectNotExistsCached(`${base}.${this._sanitizeSeg(attrType)}.persistent`, { type: 'state', common: { name: 'persistent', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} });
        await this._setObjectNotExistsCached(`${base}.${this._sanitizeSeg(attrType)}.constant`, { type: 'state', common: { name: 'constant', type: 'boolean', role: 'indicator', read: true, write: false }, native: {} });

        if (a && a.value !== undefined && parsed.val !== undefined) await this._setStateFreshAsync(valueId, parsed.val, true, 'dm');

        // Mirror ConnectedEV.StateOfCharge (Device Model) into the common aggregate `meterValues.SoC`
        // so users get SoC even if the station reports it via Device Model instead of MeterValues.
        try {
          const compName = (component && component.name) ? String(component.name) : '';
          const varName = (variable && variable.name) ? String(variable.name) : '';
          if (compName.toLowerCase() === 'connectedev' && varName.toLowerCase() === 'stateofcharge' && String(attrType).toLowerCase() === 'actual') {
            if (typeof parsed.val === 'number' && Number.isFinite(parsed.val)) {
              const socAggId = await this.ensureAgg(identity, 'SoC', '%');
              await this._setStateFreshAsync(socAggId, parsed.val, true, 'soc');
              await this._noteSoc(identity, new Date().toISOString());
            }
          }
        } catch (e) {
          // ignore
        }

        await this._setStateFreshAsync(`${base}.${this._sanitizeSeg(attrType)}.mutability`, String(mut), true, 'dm');
        await this._setStateFreshAsync(`${base}.${this._sanitizeSeg(attrType)}.persistent`, persistent, true, 'dm');
        await this._setStateFreshAsync(`${base}.${this._sanitizeSeg(attrType)}.constant`, constant, true, 'dm');
      }
    }
  }

  async ensureAliases(identity) {
    if (this._aliasDone.has(identity)) return;

    const roots = [
      {
        root: `alias.0.ocpp21.${this.instance}.${identity}`,
        parents: [
          ['alias.0.ocpp21', 'NexoWatt OCPP aliases (technical compatibility)'],
          [`alias.0.ocpp21.${this.instance}`, `NexoWatt OCPP instance ${this.instance}`],
        ],
      },
      {
        root: `alias.0.nexowatt.ocpp.${this.instance}.${identity}`,
        parents: [
          ['alias.0.nexowatt', 'NexoWatt'],
          ['alias.0.nexowatt.ocpp', 'NexoWatt OCPP'],
          [`alias.0.nexowatt.ocpp.${this.instance}`, `NexoWatt OCPP instance ${this.instance}`],
        ],
      },
    ];

    const aliases = [
      ['connected', `${identity}.info.connection`, 'boolean', 'indicator.connected', false],
      ['socketConnected', `${identity}.info.socketConnected`, 'boolean', 'indicator.connected', false],
      ['heartbeatAlive', `${identity}.health.heartbeatAlive`, 'boolean', 'indicator.connected', false],
      ['meterFresh', `${identity}.health.meterFresh`, 'boolean', 'indicator', false],
      ['powerFresh', `${identity}.health.powerFresh`, 'boolean', 'indicator', false],
      ['exportPowerFresh', `${identity}.health.exportPowerFresh`, 'boolean', 'indicator', false],
      ['currentFresh', `${identity}.health.currentFresh`, 'boolean', 'indicator', false],
      ['dataFresh', `${identity}.health.dataFresh`, 'boolean', 'indicator', false],
      ['socFresh', `${identity}.health.socFresh`, 'boolean', 'indicator', false],
      ['safeZeroApplied', `${identity}.health.safeZeroApplied`, 'boolean', 'indicator', false],
      ['staleReason', `${identity}.health.staleReason`, 'string', 'text', false],
      ['lastSeenMs', `${identity}.health.lastSeenMs`, 'number', 'value.time', false],
      ['lastHeartbeat', `${identity}.info.lastHeartbeat`, 'string', 'value.time', false],
      ['lastMeterValue', `${identity}.health.lastMeterValue`, 'string', 'value.time', false],
      ['lastPowerValue', `${identity}.health.lastPowerValue`, 'string', 'value.time', false],
      ['lastCurrentValue', `${identity}.health.lastCurrentValue`, 'string', 'value.time', false],
      ['meterAgeSec', `${identity}.health.meterAgeSec`, 'number', 'value.interval', false],
      ['powerAgeSec', `${identity}.health.powerAgeSec`, 'number', 'value.interval', false],
      ['currentAgeSec', `${identity}.health.currentAgeSec`, 'number', 'value.interval', false],
      ['socAgeSec', `${identity}.health.socAgeSec`, 'number', 'value.interval', false],
      ['status', `${identity}.info.status`, 'string', 'indicator.status', false],
      ['protocol', `${identity}.info.protocol`, 'string', 'text', false],
      ['rfid', `${identity}.info.rfid`, 'string', 'text', false],
      ['rfidType', `${identity}.info.rfidType`, 'string', 'text', false],
      ['soc', `${identity}.meterValues.SoC`, 'number', 'value.battery', false],
      ['powerW', `${identity}.meterValues.Power_Active_Import`, 'number', 'value.power', false],
      ['currentTotalA', `${identity}.meterValues.Current_Import`, 'number', 'value.current', false],
      ['energyWh', `${identity}.meterValues.Energy_Active_Import_Register`, 'number', 'value.energy', false],
      ['energyKWh', `${identity}.meterValues.Energy_Active_Import_Register_kWh`, 'number', 'value.energy', false],
      ['voltageL1', `${identity}.meterValues.Voltage_L1`, 'number', 'value.voltage', false],
      ['voltageL2', `${identity}.meterValues.Voltage_L2`, 'number', 'value.voltage', false],
      ['voltageL3', `${identity}.meterValues.Voltage_L3`, 'number', 'value.voltage', false],
      ['voltageL1N', `${identity}.meterValues.Voltage_L1N`, 'number', 'value.voltage', false],
      ['voltageL2N', `${identity}.meterValues.Voltage_L2N`, 'number', 'value.voltage', false],
      ['voltageL3N', `${identity}.meterValues.Voltage_L3N`, 'number', 'value.voltage', false],
      ['currentL1', `${identity}.meterValues.Current_Import_L1`, 'number', 'value.current', false],
      ['currentL2', `${identity}.meterValues.Current_Import_L2`, 'number', 'value.current', false],
      ['currentL3', `${identity}.meterValues.Current_Import_L3`, 'number', 'value.current', false],
      ['currentL1N', `${identity}.meterValues.Current_Import_L1N`, 'number', 'value.current', false],
      ['currentL2N', `${identity}.meterValues.Current_Import_L2N`, 'number', 'value.current', false],
      ['currentL3N', `${identity}.meterValues.Current_Import_L3N`, 'number', 'value.current', false],
      ['powerL1', `${identity}.meterValues.Power_Active_Import_L1`, 'number', 'value.power', false],
      ['powerL2', `${identity}.meterValues.Power_Active_Import_L2`, 'number', 'value.power', false],
      ['powerL3', `${identity}.meterValues.Power_Active_Import_L3`, 'number', 'value.power', false],
      ['powerL1N', `${identity}.meterValues.Power_Active_Import_L1N`, 'number', 'value.power', false],
      ['powerL2N', `${identity}.meterValues.Power_Active_Import_L2N`, 'number', 'value.power', false],
      ['powerL3N', `${identity}.meterValues.Power_Active_Import_L3N`, 'number', 'value.power', false],
      ['frequencyHz', `${identity}.meterValues.Frequency`, 'number', 'value.frequency', false],
      ['connector1Status', `${identity}.evse.1.connector.1.status`, 'string', 'indicator.status', false],
      ['connector1EnergyWh', `${identity}.evse.1.connector.1.meter.lastWh`, 'number', 'value.energy', false],
      ['connector1EnergyKWh', `${identity}.evse.1.connector.1.meter.lastKWh`, 'number', 'value.energy', false],
      ['txActive', `${identity}.transactions.transactionActive`, 'boolean', 'indicator.working', false],
      ['chargingState', `${identity}.transactions.chargingState`, 'string', 'indicator.status', false],
      ['txId', `${identity}.transactions.last.id`, 'string', 'text', false],
      ['idTag', `${identity}.transactions.idTag`, 'string', 'text', false],
      ['txEnergyWh', `${identity}.transactions.lastTransactionConsumption`, 'number', 'value.energy', false],
      ['txEnergyKWh', `${identity}.transactions.lastTransactionConsumption_kWh`, 'number', 'value.energy', false],
      ['chargeLimit', `${identity}.control.chargeLimit`, 'number', 'value.power', true],
      ['numberPhases', `${identity}.control.numberOfPhases`, 'number', 'value', true],
      ['availability', `${identity}.control.availability`, 'boolean', 'switch.power', true],
    ];

    try {
      for (const definition of roots) {
        for (const [parent, name] of definition.parents) {
          await this.setForeignObjectNotExistsAsync(parent, { type: 'channel', common: { name }, native: {} });
        }
        await this.setForeignObjectNotExistsAsync(definition.root, {
          type: 'channel',
          common: { name: this._stateToRawIdentity.get(identity) || identity },
          native: {},
        });
        for (const [name, target, type, role, write] of aliases) {
          await this.setForeignObjectNotExistsAsync(`${definition.root}.${name}`, {
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
        }
      }
      this._aliasDone.add(identity);
    } catch (e) {
      // Do not mark this identity as complete: a later structure pass may retry.
      this.log.debug(`Alias creation will be retried (${identity}): ${e}`);
    }
  }

  async ensureStructure(identity, evseId = 1, connectorId = 1) {
    const rawIdentity = this._stateToRawIdentity.get(identity) || identity;
    const state = async (id, common, native = {}) => this._setObjectNotExistsCached(id, { type: 'state', common, native });
    const channel = async (id, name, type = 'channel') => this._setObjectNotExistsCached(id, { type, common: { name }, native: {} });

    if (!this._identityStructureReady.has(identity)) {
      await channel(identity, rawIdentity);
      await channel(`${identity}.main`, 'Main', 'device');
      await channel(`${identity}.info`, 'Information');
      await channel(`${identity}.health`, 'EOS freshness and connection health');
      await channel(`${identity}.meterValues`, 'Meter values (aggregated)');
      await channel(`${identity}.control`, 'Control');
      await channel(`${identity}.transactions`, 'Transactions');
      await channel(`${identity}.transactions.last`, 'Last transaction event');
      await channel(`${identity}.evse`, 'EVSE');
      await channel(`${identity}.evChargingNeeds`, 'EV charging needs');
      const chargingNeedsStates = {
        evseId: ['number', 'value', undefined],
        timestamp: ['string', 'value.time', undefined],
        requestedEnergyTransfer: ['string', 'text', undefined],
        departureTime: ['string', 'value.time', undefined],
        stateOfCharge: ['number', 'value.battery', '%'],
        targetSoC: ['number', 'value.battery', '%'],
        fullSoC: ['number', 'value.battery', '%'],
        bulkSoC: ['number', 'value.battery', '%'],
        energyAmountWh: ['number', 'value.energy', 'Wh'],
        evEnergyCapacityWh: ['number', 'value.energy', 'Wh'],
        evMaxPowerW: ['number', 'value.power', 'W'],
        evMaxCurrentA: ['number', 'value.current', 'A'],
        evMaxVoltageV: ['number', 'value.voltage', 'V'],
        maxScheduleTuples: ['number', 'value', undefined],
      };
      for (const [key, [type, role, unit]] of Object.entries(chargingNeedsStates)) {
        await state(`${identity}.evChargingNeeds.${key}`, { name: key, type, role, read: true, write: false, unit });
      }

      const info = {
        identity: { type: 'string', role: 'text' },
        stateIdentity: { type: 'string', role: 'text' },
        connection: { type: 'boolean', role: 'indicator.connected', def: false },
        socketConnected: { type: 'boolean', role: 'indicator.connected', def: false },
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
        heartbeatInterval: { type: 'number', role: 'value.interval', unit: 's' },
        lastHeartbeat: { type: 'string', role: 'value.time' },
        firmwareStatus: { type: 'string', role: 'text' },
        diagnosticsStatus: { type: 'string', role: 'text' },
        logStatus: { type: 'string', role: 'text' },
      };
      for (const [key, definition] of Object.entries(info)) {
        await state(`${identity}.info.${key}`, {
          name: key,
          type: definition.type,
          role: definition.role,
          read: true,
          write: false,
          def: definition.def,
          unit: definition.unit,
        });
      }

      const health = {
        online: ['boolean', 'indicator.connected', false],
        socketConnected: ['boolean', 'indicator.connected', false],
        heartbeatAlive: ['boolean', 'indicator.connected', false],
        meterFresh: ['boolean', 'indicator', false],
        powerFresh: ['boolean', 'indicator', false],
        exportPowerFresh: ['boolean', 'indicator', false],
        currentFresh: ['boolean', 'indicator', false],
        dataFresh: ['boolean', 'indicator', false],
        socFresh: ['boolean', 'indicator', false],
        staleReason: ['string', 'text', ''],
        heartbeat: ['string', 'value.time', ''],
        lastHeartbeatMs: ['number', 'value.time', 0],
        lastSeen: ['string', 'value.time', ''],
        lastSeenMs: ['number', 'value.time', 0],
        lastAction: ['string', 'text', ''],
        lastBoot: ['string', 'value.time', ''],
        lastMeterValue: ['string', 'value.time', ''],
        lastPowerValue: ['string', 'value.time', ''],
        lastExportPowerValue: ['string', 'value.time', ''],
        lastCurrentValue: ['string', 'value.time', ''],
        lastSoc: ['string', 'value.time', ''],
        messageAgeSec: ['number', 'value.interval', -1],
        heartbeatAgeSec: ['number', 'value.interval', -1],
        meterAgeSec: ['number', 'value.interval', -1],
        powerAgeSec: ['number', 'value.interval', -1],
        exportPowerAgeSec: ['number', 'value.interval', -1],
        currentAgeSec: ['number', 'value.interval', -1],
        statusAgeSec: ['number', 'value.interval', -1],
        socAgeSec: ['number', 'value.interval', -1],
        refreshStatus: ['string', 'text', 'not-run'],
        refreshSupport: ['string', 'json', '{}'],
        refreshLastAttempt: ['string', 'value.time', ''],
        refreshLastSuccess: ['string', 'value.time', ''],
        refreshLastError: ['string', 'text', ''],
        lastRepublish: ['string', 'value.time', ''],
        safeZeroApplied: ['boolean', 'indicator', false],
        safeZeroReason: ['string', 'text', ''],
      };
      for (const [key, [type, role, def]] of Object.entries(health)) {
        await state(`${identity}.health.${key}`, { name: key, type, role, read: true, write: false, def, unit: key.endsWith('AgeSec') ? 's' : undefined });
      }

      await state(`${identity}.control.availability`, { name: 'Switch availability', type: 'boolean', role: 'switch.power', read: true, write: true, def: true });
      await channel(`${identity}.control.hardReset`, 'Hard reset');
      await channel(`${identity}.control.softReset`, 'Soft reset');
      await state(`${identity}.control.hardReset.trigger`, { name: 'Trigger hard reset', type: 'boolean', role: 'button', read: true, write: true, def: false });
      await state(`${identity}.control.softReset.trigger`, { name: 'Trigger soft reset', type: 'boolean', role: 'button', read: true, write: true, def: false });
      await state(`${identity}.control.chargeLimit`, { name: 'Charging limit', type: 'number', role: 'value.power', read: true, write: true, unit: 'W', min: 0 });
      await state(`${identity}.control.chargeLimitType`, { name: 'Charging limit unit', type: 'string', role: 'text', read: true, write: true, def: 'W', states: { W: 'W', A: 'A' } });
      await state(`${identity}.control.numberOfPhases`, { name: 'Number of phases (smart charging)', type: 'number', role: 'value', read: true, write: true, def: 3, min: 1, max: 3 });
      await state(`${identity}.control.lastCommand`, { name: 'Last OCPP command', type: 'string', role: 'text', read: true, write: false });
      await state(`${identity}.control.lastCommandAt`, { name: 'Last command timestamp', type: 'string', role: 'value.time', read: true, write: false });
      await state(`${identity}.control.lastResponse`, { name: 'Last command response', type: 'string', role: 'json', read: true, write: false });
      await state(`${identity}.control.lastError`, { name: 'Last command error', type: 'string', role: 'text', read: true, write: false });
      await state(`${identity}.control.lastSuccess`, { name: 'Last command successful', type: 'boolean', role: 'indicator', read: true, write: false, def: false });

      await channel(`${identity}.control.rpc`, 'Generic OCPP RPC');
      await state(`${identity}.control.rpc.method`, { name: 'OCPP method/action', type: 'string', role: 'text', read: true, write: true });
      await state(`${identity}.control.rpc.payload`, { name: 'OCPP payload (JSON)', type: 'string', role: 'json', read: true, write: true });
      await state(`${identity}.control.rpc.execute`, { name: 'Execute call', type: 'boolean', role: 'button', read: true, write: true, def: false });
      await state(`${identity}.control.rpc.lastResponse`, { name: 'Last response (JSON)', type: 'string', role: 'json', read: true, write: false });
      await state(`${identity}.control.rpc.lastError`, { name: 'Last error', type: 'string', role: 'text', read: true, write: false });

      await channel(`${identity}.control.requestStartTransaction`, 'Request/Remote start transaction');
      await state(`${identity}.control.requestStartTransaction.idToken`, { name: 'idToken / idTag', type: 'string', role: 'text', read: true, write: true });
      await state(`${identity}.control.requestStartTransaction.idTokenType`, { name: 'idToken type (2.x)', type: 'string', role: 'text', read: true, write: true, def: 'Central' });
      await state(`${identity}.control.requestStartTransaction.evseId`, { name: 'EVSE Id (2.x) / connectorId (1.6)', type: 'number', role: 'value', read: true, write: true, def: 1, min: 0 });
      await state(`${identity}.control.requestStartTransaction.remoteStartId`, { name: 'remoteStartId (2.x)', type: 'number', role: 'value', read: true, write: true, def: 1, min: 1 });
      await state(`${identity}.control.requestStartTransaction.chargingProfile`, { name: 'Optional chargingProfile JSON (2.x)', type: 'string', role: 'json', read: true, write: true });
      await state(`${identity}.control.requestStartTransaction.trigger`, { name: 'Trigger start transaction', type: 'boolean', role: 'button', read: true, write: true, def: false });
      await state(`${identity}.control.requestStartTransaction.lastResponse`, { name: 'Last response (JSON)', type: 'string', role: 'json', read: true, write: false });
      await state(`${identity}.control.requestStartTransaction.lastError`, { name: 'Last error', type: 'string', role: 'text', read: true, write: false });

      await channel(`${identity}.control.requestStopTransaction`, 'Request/Remote stop transaction');
      await state(`${identity}.control.requestStopTransaction.transactionId`, { name: 'transactionId (empty = last)', type: 'string', role: 'text', read: true, write: true });
      await state(`${identity}.control.requestStopTransaction.trigger`, { name: 'Trigger stop transaction', type: 'boolean', role: 'button', read: true, write: true, def: false });
      await state(`${identity}.control.requestStopTransaction.lastResponse`, { name: 'Last response (JSON)', type: 'string', role: 'json', read: true, write: false });
      await state(`${identity}.control.requestStopTransaction.lastError`, { name: 'Last error', type: 'string', role: 'text', read: true, write: false });

      const txStates = {
        idTag: ['string', 'text'],
        idTagType: ['string', 'text'],
        transactionActive: ['boolean', 'indicator.working', false],
        chargingState: ['string', 'indicator.status'],
        triggerReason: ['string', 'text'],
        seqNo: ['number', 'value'],
        transactionStartMeter: ['number', 'value.energy', undefined, 'Wh'],
        transactionStartMeter_kWh: ['number', 'value.energy', undefined, 'kWh'],
        transactionEndMeter: ['number', 'value.energy', undefined, 'Wh'],
        transactionEndMeter_kWh: ['number', 'value.energy', undefined, 'kWh'],
        lastTransactionConsumption: ['number', 'value.energy', undefined, 'Wh'],
        lastTransactionConsumption_kWh: ['number', 'value.energy', undefined, 'kWh'],
        numberPhases: ['number', 'value'],
      };
      for (const [key, [type, role, def, unit]] of Object.entries(txStates)) {
        await state(`${identity}.transactions.${key}`, { name: key, type, role, read: true, write: false, def, unit });
      }
      const lastTxStates = {
        type: ['string', 'text'], id: ['string', 'text'], evseId: ['number', 'value'], connectorId: ['number', 'value'],
        idTag: ['string', 'text'], meterStart: ['number', 'value.energy', 'Wh'], meterStart_kWh: ['number', 'value.energy', 'kWh'],
        meterStop: ['number', 'value.energy', 'Wh'], meterStop_kWh: ['number', 'value.energy', 'kWh'], reason: ['string', 'text'], ts: ['string', 'value.time'],
      };
      for (const [key, [type, role, unit]] of Object.entries(lastTxStates)) {
        await state(`${identity}.transactions.last.${key}`, { name: key, type, role, read: true, write: false, unit });
      }

      // Stable EOS aggregate datapoints are created even before the first sample arrives.
      await this.ensureAgg(identity, 'Power_Active_Import', 'W');
      await this.ensureAgg(identity, 'Power_Active_Export', 'W');
      await this.ensureAgg(identity, 'Current_Import', 'A');
      await this.ensureAgg(identity, 'Current_Export', 'A');
      await this.ensureAgg(identity, 'SoC', '%');

      this._identityStructureReady.add(identity);
    }

    if (!this._aliasDone.has(identity)) await this.ensureAliases(identity);

    const evse = Math.max(0, Number(evseId) || 0);
    const connector = Math.max(0, Number(connectorId) || 0);
    const connectorKey = `${identity}|${evse}|${connector}`;
    if (!this._connectorStructureReady.has(connectorKey)) {
      await channel(`${identity}.evse.${evse}`, `EVSE ${evse}`);
      await channel(`${identity}.evse.${evse}.connector`, 'Connector');
      const base = `${identity}.evse.${evse}.connector.${connector}`;
      await channel(base, `Connector ${connector}`);
      await state(`${base}.status`, { name: 'status', type: 'string', role: 'indicator.status', read: true, write: false });
      await state(`${base}.errorCode`, { name: 'errorCode', type: 'string', role: 'text', read: true, write: false });
      await state(`${base}.info`, { name: 'info', type: 'string', role: 'text', read: true, write: false });
      await state(`${base}.vendorErrorCode`, { name: 'vendorErrorCode', type: 'string', role: 'text', read: true, write: false });
      await state(`${base}.vendorId`, { name: 'vendorId', type: 'string', role: 'text', read: true, write: false });
      await state(`${base}.ts`, { name: 'timestamp', type: 'string', role: 'value.time', read: true, write: false });
      await channel(`${base}.meter`, 'Meter');
      await state(`${base}.meter.lastWh`, { name: 'Last energy', type: 'number', role: 'value.energy', read: true, write: false, unit: 'Wh' });
      await state(`${base}.meter.lastKWh`, { name: 'Last energy', type: 'number', role: 'value.energy', read: true, write: false, unit: 'kWh' });
      await state(`${base}.meter.lastTs`, { name: 'Last meter timestamp', type: 'string', role: 'value.time', read: true, write: false });
      this._connectorStructureReady.add(connectorKey);
    }
  }

  async ensureMetric(identity, evseId, connectorId, key, unit) {
    await this.ensureStructure(identity, evseId, connectorId);
    const id = `${identity}.evse.${evseId}.connector.${connectorId}.meter.${key}`;
    let role = 'value';
    if (/Power/i.test(key)) role = 'value.power';
    else if (/Current/i.test(key)) role = 'value.current';
    else if (/Voltage/i.test(key)) role = 'value.voltage';
    else if (/Energy|lastWh|lastKWh/i.test(key)) role = 'value.energy';
    else if (/SoC/i.test(key)) role = 'value.battery';
    await this._setObjectNotExistsCached(id, { type: 'state', common: { name: key, type: 'number', role, read: true, write: false, unit: unit || undefined }, native: {} });
    return id;
  }

  async ensureAgg(identity, key, unit) {
    const id = `${identity}.meterValues.${key}`;
    let role = 'value';
    if (/Power/i.test(key)) role = 'value.power';
    else if (/Current/i.test(key)) role = 'value.current';
    else if (/Voltage/i.test(key)) role = 'value.voltage';
    else if (/Energy/i.test(key)) role = 'value.energy';
    else if (/SoC/i.test(key)) role = 'value.battery';
    await this._setObjectNotExistsCached(`${identity}.meterValues`, { type: 'channel', common: { name: 'Meter values (aggregated)' }, native: {} });
    await this._setObjectNotExistsCached(id, { type: 'state', common: { name: key, type: 'number', role, read: true, write: false, unit: unit || undefined }, native: {} });
    return id;
  }

  async _setDisconnectedHealth(identity, reason) {
    await this.ensureStructure(identity);
    const writes = {
      [`${identity}.info.connection`]: false,
      [`${identity}.info.socketConnected`]: false,
      [`${identity}.health.online`]: false,
      [`${identity}.health.socketConnected`]: false,
      [`${identity}.health.heartbeatAlive`]: false,
      [`${identity}.health.meterFresh`]: false,
      [`${identity}.health.powerFresh`]: false,
      [`${identity}.health.exportPowerFresh`]: false,
      [`${identity}.health.currentFresh`]: false,
      [`${identity}.health.socFresh`]: false,
      [`${identity}.health.dataFresh`]: false,
      [`${identity}.health.safeZeroApplied`]: false,
      [`${identity}.health.safeZeroReason`]: '',
      [`${identity}.health.messageAgeSec`]: -1,
      [`${identity}.health.heartbeatAgeSec`]: -1,
      [`${identity}.health.meterAgeSec`]: -1,
      [`${identity}.health.powerAgeSec`]: -1,
      [`${identity}.health.exportPowerAgeSec`]: -1,
      [`${identity}.health.currentAgeSec`]: -1,
      [`${identity}.health.statusAgeSec`]: -1,
      [`${identity}.health.socAgeSec`]: -1,
      [`${identity}.health.refreshStatus`]: 'offline',
      [`${identity}.health.staleReason`]: String(reason || 'socket-disconnected'),
    };
    for (const [id, value] of Object.entries(writes)) {
      await this._setStateFreshAsync(id, value, true, id.includes('.health.') ? 'health' : 'status');
    }
  }

  async _resetPersistedHealth() {
    const identities = new Set();
    const queries = [];
    if (typeof this.getStatesAsync === 'function') {
      queries.push(['getStatesAsync', '*.health.online'], ['getStatesAsync', '*.info.connection']);
    }
    if (typeof this.getForeignStatesAsync === 'function') {
      queries.push(
        ['getForeignStatesAsync', `${this.namespace}.*.health.online`],
        ['getForeignStatesAsync', `${this.namespace}.*.info.connection`],
      );
    }
    for (const [method, pattern] of queries) {
      try {
        const states = await this[method](pattern);
        for (const id of Object.keys(states || {})) {
          const rel = this._stripNs(id);
          const suffix = rel.endsWith('.health.online') ? '.health.online' : rel.endsWith('.info.connection') ? '.info.connection' : '';
          if (suffix) identities.add(rel.slice(0, -suffix.length));
        }
      } catch (e) {
        this.log.debug(`Could not inspect persisted OCPP health states (${pattern}): ${e && e.message || e}`);
      }
    }
    for (const identity of identities) {
      if (!identity) continue;
      try {
        await this._setDisconnectedHealth(identity, 'adapter-restarted-awaiting-station');
      } catch (e) {
        this.log.warn(`Could not reset persisted health for ${identity}: ${e && e.message || e}`);
      }
    }
  }

  async onReady() {
    // Never leave persisted online/fresh flags true after an unclean restart.
    await this._resetPersistedHealth();

    const allowlist = Array.isArray(this.config.identityAllowlist)
      ? this.config.identityAllowlist.map(String).map((v) => v.trim()).filter(Boolean)
      : String(this.config.identityAllowlist || '').split(',').map((v) => v.trim()).filter(Boolean);

    const ctx = {
      log: this.log,
      config: {
        port: Math.max(1, Math.min(65535, Number(this.config.port) || 9220)),
        enable16: this.config.enable16 !== false,
        enable201: this.config.enable201 !== false,
        enable21: this.config.enable21 !== false,
        heartbeatIntervalSec: Math.max(10, Number(this.config.heartbeatIntervalSec) || 300),
        identityAllowlist: allowlist,
        callTimeoutSec: Math.max(5, Number(this.config.callTimeoutSec) || 20),
      },
      states: {
        setConnection: async (id, online, meta = {}) => {
          await this.ensureStructure(id);
          const entry = this.runtimeIndex.get(id);
          if (entry) entry.socketConnected = meta.socketConnected !== undefined ? !!meta.socketConnected : !!online;
          await this._setStateFreshAsync(`${id}.info.connection`, !!online, true, 'status');
          await this._setStateFreshAsync(`${id}.info.socketConnected`, meta.socketConnected !== undefined ? !!meta.socketConnected : !!online, true, 'status');
          await this._setStateFreshAsync(`${id}.health.online`, !!online, true, 'health');
          await this._setStateFreshAsync(`${id}.health.socketConnected`, meta.socketConnected !== undefined ? !!meta.socketConnected : !!online, true, 'health');
          if (!online) {
            await this._setDisconnectedHealth(id, 'socket-disconnected');
          } else {
            for (const key of ['heartbeatAlive', 'meterFresh', 'powerFresh', 'exportPowerFresh', 'currentFresh', 'dataFresh', 'socFresh', 'safeZeroApplied']) {
              await this._setStateFreshAsync(`${id}.health.${key}`, false, true, 'health');
            }
            await this._setStateFreshAsync(`${id}.health.safeZeroReason`, '', true, 'health');
            await this._setStateFreshAsync(`${id}.health.staleReason`, 'awaiting-power-or-idle-status', true, 'health');
          }
          if (meta.rawIdentity !== undefined) {
            await this._setStateFreshAsync(`${id}.info.identity`, String(meta.rawIdentity), true, 'static');
            await this._setStateFreshAsync(`${id}.info.stateIdentity`, id, true, 'static');
          }
          if (meta.protocol !== undefined) await this._setStateFreshAsync(`${id}.info.protocol`, String(meta.protocol), true, 'static');
        },
        upsertIdentityMeta: async (id, meta) => {
          await this.ensureStructure(id);
          const infoKeys = ['protocol', 'vendor', 'model', 'firmwareVersion', 'serialNumber', 'chargePointSerialNumber', 'chargeBoxSerialNumber', 'iccid', 'imsi', 'meterType', 'meterSerialNumber'];
          const map = { firmwareVersion: 'firmware' };
          for (const key of infoKeys) {
            if (meta[key] !== undefined && meta[key] !== null) {
              await this._setStateFreshAsync(`${id}.info.${map[key] || key}`, meta[key], true, 'static');
            }
          }
          const rawIdentity = this._stateToRawIdentity.get(id) || id;
          await this._setStateFreshAsync(`${id}.info.identity`, rawIdentity, true, 'static');
          await this._setStateFreshAsync(`${id}.info.stateIdentity`, id, true, 'static');
        },
        upsertEvseState: async (id, evseId, connectorId, patch) => {
          await this.ensureStructure(id, evseId, connectorId);
          const base = `${id}.evse.${evseId}.connector.${connectorId}`;
          if (patch.status !== undefined) {
            await this._setStateFreshAsync(`${base}.status`, patch.status, true, 'status');
            await this._setStateFreshAsync(`${id}.info.status`, patch.status, true, 'status');
          }
          if (patch.errorCode !== undefined) await this._setStateFreshAsync(`${base}.errorCode`, patch.errorCode, true, 'status');
          if (patch.timestamp !== undefined) await this._setStateFreshAsync(`${base}.ts`, patch.timestamp, true, 'status');
          if (patch.info !== undefined) await this._setStateFreshAsync(`${base}.info`, patch.info, true, 'status');
          if (patch.vendorErrorCode !== undefined) await this._setStateFreshAsync(`${base}.vendorErrorCode`, patch.vendorErrorCode, true, 'status');
          if (patch.vendorId !== undefined) await this._setStateFreshAsync(`${base}.vendorId`, patch.vendorId, true, 'status');
        },
        pushTransactionEvent: async (id, evt) => {
          await this.ensureStructure(id, evt.evseId || 1, evt.connectorId || 1);
          const base = `${id}.transactions.last`;
          if (evt.type !== undefined) await this._setStateFreshAsync(`${base}.type`, evt.type, true, 'transaction');
          if (evt.txId !== undefined) await this._setStateFreshAsync(`${base}.id`, String(evt.txId), true, 'transaction');
          if (evt.evseId !== undefined) await this._setStateFreshAsync(`${base}.evseId`, Number(evt.evseId), true, 'transaction');
          if (evt.connectorId !== undefined) await this._setStateFreshAsync(`${base}.connectorId`, Number(evt.connectorId), true, 'transaction');
          if (evt.idTag !== undefined) {
            await this._setStateFreshAsync(`${base}.idTag`, evt.idTag, true, 'transaction');
            await this._setStateFreshAsync(`${id}.transactions.idTag`, evt.idTag, true, 'transaction');
            await this._setStateFreshAsync(`${id}.info.rfid`, evt.idTag, true, 'status');
          }
          if (evt.idTokenType !== undefined) {
            await this._setStateFreshAsync(`${id}.transactions.idTagType`, String(evt.idTokenType), true, 'transaction');
            await this._setStateFreshAsync(`${id}.info.rfidType`, String(evt.idTokenType), true, 'status');
          }
          if (evt.meterStart !== undefined && Number.isFinite(Number(evt.meterStart))) {
            const wh = Number(evt.meterStart);
            await this._setStateFreshAsync(`${base}.meterStart`, wh, true, 'counter');
            await this._setStateFreshAsync(`${base}.meterStart_kWh`, wh / 1000, true, 'counter');
            await this._setStateFreshAsync(`${id}.transactions.transactionStartMeter`, wh, true, 'counter');
            await this._setStateFreshAsync(`${id}.transactions.transactionStartMeter_kWh`, wh / 1000, true, 'counter');
          }
          if (evt.meterStop !== undefined && Number.isFinite(Number(evt.meterStop))) {
            const whStop = Number(evt.meterStop);
            await this._setStateFreshAsync(`${base}.meterStop`, whStop, true, 'counter');
            await this._setStateFreshAsync(`${base}.meterStop_kWh`, whStop / 1000, true, 'counter');
            await this._setStateFreshAsync(`${id}.transactions.transactionEndMeter`, whStop, true, 'counter');
            await this._setStateFreshAsync(`${id}.transactions.transactionEndMeter_kWh`, whStop / 1000, true, 'counter');
            const startWh = Number((await this.getStateAsync(`${id}.transactions.transactionStartMeter`))?.val);
            if (Number.isFinite(startWh)) {
              const consumptionWh = Math.max(0, whStop - startWh);
              await this._setStateFreshAsync(`${id}.transactions.lastTransactionConsumption`, consumptionWh, true, 'counter');
              await this._setStateFreshAsync(`${id}.transactions.lastTransactionConsumption_kWh`, consumptionWh / 1000, true, 'counter');
            }
          }
          if (evt.reason !== undefined) await this._setStateFreshAsync(`${base}.reason`, evt.reason, true, 'transaction');
          if (evt.ts !== undefined) await this._setStateFreshAsync(`${base}.ts`, evt.ts, true, 'transaction');
          if (evt.chargingState !== undefined) await this._setStateFreshAsync(`${id}.transactions.chargingState`, String(evt.chargingState || ''), true, 'status');
          if (evt.triggerReason !== undefined) await this._setStateFreshAsync(`${id}.transactions.triggerReason`, String(evt.triggerReason || ''), true, 'transaction');
          if (evt.seqNo !== undefined && Number.isFinite(Number(evt.seqNo))) await this._setStateFreshAsync(`${id}.transactions.seqNo`, Number(evt.seqNo), true, 'transaction');
          if (evt.type === 'Start') await this._setStateFreshAsync(`${id}.transactions.transactionActive`, true, true, 'status');
          if (evt.type === 'Stop') await this._setStateFreshAsync(`${id}.transactions.transactionActive`, false, true, 'status');
          await this._noteTransaction(id, evt);
        },
        setRfid: async (id, token, tokenType) => {
          await this.ensureStructure(id);
          if (token !== undefined && token !== null && String(token).length) {
            await this._setStateFreshAsync(`${id}.info.rfid`, String(token), true, 'status');
            await this._setStateFreshAsync(`${id}.transactions.idTag`, String(token), true, 'transaction');
          }
          if (tokenType !== undefined && tokenType !== null && String(tokenType).length) {
            await this._setStateFreshAsync(`${id}.info.rfidType`, String(tokenType), true, 'status');
            await this._setStateFreshAsync(`${id}.transactions.idTagType`, String(tokenType), true, 'transaction');
          }
        },
        ensureMetricState: this.ensureMetric.bind(this),
        ensureAggState: this.ensureAgg.bind(this),
        ensureStructure: this.ensureStructure.bind(this),
      },
      runtime: {
        resolveIdentity: this.resolveStationIdentity.bind(this),
        indexClient: this._indexClient.bind(this),
        unindexClient: this._unindexClient.bind(this),
        getClient: (id) => (this.runtimeIndex.get(id) || {}).client,
        noteMessage: this._noteMessage.bind(this),
        noteBoot: this._noteBoot.bind(this),
        noteHeartbeat: this._noteHeartbeat.bind(this),
        noteStatus: this._noteStatus.bind(this),
        noteMeterValue: this._noteMeterValue.bind(this),
        noteSoc: this._noteSoc.bind(this),
        recordPhaseMetric: this._recordPhaseMetric.bind(this),
        getPhaseMetricTotal: this._getPhaseMetricTotal.bind(this),
      },
      dp: { capture: this.captureOcppPayload.bind(this) },
      dm: { ingestNotifyReport: this.ingestNotifyReport.bind(this) },
      setStateChangedAsync: this.setStateChangedAsync.bind(this),
      setStateFreshAsync: this._setStateFreshAsync.bind(this),
    };

    const protocols = []
      .concat(ctx.config.enable16 ? ['ocpp1.6'] : [])
      .concat(ctx.config.enable201 ? ['ocpp2.0.1'] : [])
      .concat(ctx.config.enable21 ? ['ocpp2.1'] : []);
    if (protocols.length === 0) throw new Error('At least one OCPP protocol must be enabled');

    this.server = new OcppRpcServer(ctx, { port: ctx.config.port, protocols, strictMode: false });
    await this.server.listen();
    this.subscribeStates('*');

    const healthCheckMs = Math.max(2, Number(this.config.healthCheckIntervalSec) || 5) * 1000;
    this._watchdogTimer = setInterval(() => this._watchdogCycle(), healthCheckMs);
    await this._watchdogCycle();
    this.log.info('NexoWatt OCPP adapter ready for NexoWatt EOS');
  }

  async onStateChange(id, state) {
    if (!state || state.ack || this._shuttingDown) return;
    const rel = this._stripNs(id);
    const match = (pattern) => rel.match(pattern);
    const mDmValue = match(/^([^\.]+)\.dm\..+\.value$/);
    const mHard = match(/^([^\.]+)\.control\.hardReset\.trigger$/);
    const mSoft = match(/^([^\.]+)\.control\.softReset\.trigger$/);
    const mAvail = match(/^([^\.]+)\.control\.availability$/);
    const mLimit = match(/^([^\.]+)\.control\.chargeLimit$/);
    const mLimitType = match(/^([^\.]+)\.control\.chargeLimitType$/);
    const mPhases = match(/^([^\.]+)\.control\.numberOfPhases$/);
    const mRpcExec = match(/^([^\.]+)\.control\.rpc\.execute$/);
    const mRpcMethod = match(/^([^\.]+)\.control\.rpc\.method$/);
    const mRpcPayload = match(/^([^\.]+)\.control\.rpc\.payload$/);
    const mReqStartTrigger = match(/^([^\.]+)\.control\.requestStartTransaction\.trigger$/);
    const mReqStartIdToken = match(/^([^\.]+)\.control\.requestStartTransaction\.idToken$/);
    const mReqStartIdTokenType = match(/^([^\.]+)\.control\.requestStartTransaction\.idTokenType$/);
    const mReqStartEvseId = match(/^([^\.]+)\.control\.requestStartTransaction\.evseId$/);
    const mReqStartRemoteStartId = match(/^([^\.]+)\.control\.requestStartTransaction\.remoteStartId$/);
    const mReqStartProfile = match(/^([^\.]+)\.control\.requestStartTransaction\.chargingProfile$/);
    const mReqStopTrigger = match(/^([^\.]+)\.control\.requestStopTransaction\.trigger$/);
    const mReqStopTxId = match(/^([^\.]+)\.control\.requestStopTransaction\.transactionId$/);

    const matches = [mDmValue, mHard, mSoft, mAvail, mLimit, mLimitType, mPhases, mRpcExec, mRpcMethod, mRpcPayload,
      mReqStartTrigger, mReqStartIdToken, mReqStartIdTokenType, mReqStartEvseId, mReqStartRemoteStartId,
      mReqStartProfile, mReqStopTrigger, mReqStopTxId];
    const identityMatch = matches.find(Boolean);
    if (!identityMatch) return;
    const identity = identityMatch[1];

    const ack = async (value) => this._setStateFreshAsync(rel, value, true, 'control');
    const setSpecificResult = async (section, response, error) => {
      if (!section) return;
      const errorText = error ? String(error && error.message || error) : '';
      await this._setStateFreshAsync(`${identity}.control.${section}.lastResponse`, errorText ? '' : this._stringifyControlValue(response), true, 'control');
      await this._setStateFreshAsync(`${identity}.control.${section}.lastError`, errorText, true, 'control');
    };
    const succeed = async (method, response, ackValue, section) => {
      await this._recordControlResult(identity, method, response, undefined);
      await setSpecificResult(section, response, undefined);
      await ack(ackValue);
    };
    const fail = async (method, error, ackValue, section) => {
      this.log.warn(`NexoWatt OCPP control failed (${identity}, ${method}): ${error && error.message || error}`);
      await this._recordControlResult(identity, method, undefined, error);
      await setSpecificResult(section, undefined, error);
      await ack(ackValue);
    };

    // Pure configuration/input states are retained locally and do not trigger an OCPP call by themselves.
    if (mRpcMethod || mRpcPayload || mLimitType || mReqStartIdToken || mReqStartIdTokenType
      || mReqStartEvseId || mReqStartRemoteStartId || mReqStartProfile || mReqStopTxId) {
      await ack(state.val);
      return;
    }

    const entry = this.runtimeIndex.get(identity);
    const proto = entry && entry.proto;
    const call = (method, payload) => this._callClient(identity, method, payload);
    const action = mDmValue ? 'SetVariables'
      : mHard || mSoft ? 'Reset'
        : mAvail ? 'ChangeAvailability'
          : mLimit || mPhases ? 'SetChargingProfile'
            : mRpcExec ? 'RPC'
              : mReqStartTrigger ? (proto === 'ocpp1.6' ? 'RemoteStartTransaction' : 'RequestStartTransaction')
                : mReqStopTrigger ? (proto === 'ocpp1.6' ? 'RemoteStopTransaction' : 'RequestStopTransaction')
                  : 'Control';
    const section = mRpcExec ? 'rpc' : mReqStartTrigger ? 'requestStartTransaction' : mReqStopTrigger ? 'requestStopTransaction' : undefined;

    let offlineAckValue = state.val;
    if (mHard || mSoft || mRpcExec || mReqStartTrigger || mReqStopTrigger) offlineAckValue = false;
    if (mAvail) offlineAckValue = !!state.val;
    if (mLimit) offlineAckValue = Math.max(0, Number.isFinite(Number(state.val)) ? Number(state.val) : 0);
    if (mPhases) offlineAckValue = Math.max(1, Math.min(3, Math.round(Number(state.val) || 3)));

    if (!entry || !entry.client) {
      await fail(action, new Error('Charging station is not connected'), offlineAckValue, section);
      return;
    }

    try {
      if (mDmValue) {
        if (proto === 'ocpp1.6') throw new Error('Device Model SetVariables is only available with OCPP 2.x');
        let meta = this._dmIndex.get(id) || this._dmIndex.get(`${this.namespace}.${rel}`);
        if (!meta) {
          const obj = await this.getObjectAsync(rel);
          meta = obj && obj.native && obj.native.ocppDm;
        }
        if (!meta || !meta.component || !meta.variable) throw new Error('Missing Device Model metadata for this datapoint');
        const response = await call('SetVariables', {
          setVariableData: [{
            component: meta.component,
            variable: meta.variable,
            attributeType: meta.attributeType,
            attributeValue: String(state.val),
          }],
        });
        const results = Array.isArray(response && response.setVariableResult) ? response.setVariableResult : [];
        const rejected = results.filter((result) => String(result && result.attributeStatus || '').toLowerCase() !== 'accepted');
        if (rejected.length) throw new Error(`SetVariables was not accepted: ${this._stringifyControlValue(rejected)}`);
        await succeed('SetVariables', response, state.val);
        return;
      }

      if (mRpcExec) {
        if (!state.val) { await ack(false); return; }
        const method = String((await this.getStateAsync(`${identity}.control.rpc.method`))?.val || '').trim();
        const payloadText = String((await this.getStateAsync(`${identity}.control.rpc.payload`))?.val || '').trim();
        if (!method) throw new Error('Missing OCPP method/action');
        let payload = {};
        if (payloadText) {
          try { payload = JSON.parse(payloadText); } catch (e) { throw new Error(`Payload is not valid JSON: ${e.message}`); }
        }
        const response = await call(method, payload);
        await succeed(method, response, false, 'rpc');
        return;
      }

      if (mReqStartTrigger) {
        if (!state.val) { await ack(false); return; }
        const idToken = String((await this.getStateAsync(`${identity}.control.requestStartTransaction.idToken`))?.val || '').trim();
        const idTokenType = String((await this.getStateAsync(`${identity}.control.requestStartTransaction.idTokenType`))?.val || 'Central').trim() || 'Central';
        const evseId = Math.max(0, Number((await this.getStateAsync(`${identity}.control.requestStartTransaction.evseId`))?.val || 1));
        let remoteStartId = Number((await this.getStateAsync(`${identity}.control.requestStartTransaction.remoteStartId`))?.val || 0);
        if (!Number.isFinite(remoteStartId) || remoteStartId <= 0) remoteStartId = Math.floor(Math.random() * 0x7ffffffe) + 1;
        if (!idToken) throw new Error('Missing idToken/idTag');

        let response;
        if (proto === 'ocpp1.6') {
          response = await call('RemoteStartTransaction', { connectorId: evseId || 1, idTag: idToken });
          this._assertCallAccepted('RemoteStartTransaction', response);
        } else {
          const payload = { idToken: { idToken, type: idTokenType }, remoteStartId };
          if (evseId > 0) payload.evseId = evseId;
          const profileText = String((await this.getStateAsync(`${identity}.control.requestStartTransaction.chargingProfile`))?.val || '').trim();
          if (profileText) {
            try { payload.chargingProfile = JSON.parse(profileText); } catch (e) { throw new Error(`chargingProfile is not valid JSON: ${e.message}`); }
          }
          response = await call('RequestStartTransaction', payload);
          this._assertCallAccepted('RequestStartTransaction', response);
        }
        await this._setStateFreshAsync(`${identity}.control.requestStartTransaction.remoteStartId`, remoteStartId, true, 'control');
        await succeed(proto === 'ocpp1.6' ? 'RemoteStartTransaction' : 'RequestStartTransaction', response, false, 'requestStartTransaction');
        return;
      }

      if (mReqStopTrigger) {
        if (!state.val) { await ack(false); return; }
        let transactionId = String((await this.getStateAsync(`${identity}.control.requestStopTransaction.transactionId`))?.val || '').trim();
        if (!transactionId) transactionId = String((await this.getStateAsync(`${identity}.transactions.last.id`))?.val || '').trim();
        if (!transactionId) throw new Error('Missing transactionId and no last transaction is known');
        const response = proto === 'ocpp1.6'
          ? await call('RemoteStopTransaction', { transactionId: Number.isFinite(Number(transactionId)) ? Number(transactionId) : transactionId })
          : await call('RequestStopTransaction', { transactionId });
        this._assertCallAccepted(proto === 'ocpp1.6' ? 'RemoteStopTransaction' : 'RequestStopTransaction', response);
        await this._setStateFreshAsync(`${identity}.control.requestStopTransaction.transactionId`, transactionId, true, 'control');
        await succeed(proto === 'ocpp1.6' ? 'RemoteStopTransaction' : 'RequestStopTransaction', response, false, 'requestStopTransaction');
        return;
      }

      if (mHard || mSoft) {
        if (!state.val) { await ack(false); return; }
        const type = proto === 'ocpp1.6' ? (mHard ? 'Hard' : 'Soft') : (mHard ? 'Immediate' : 'OnIdle');
        const response = await call('Reset', { type });
        this._assertCallAccepted('Reset', response);
        await succeed('Reset', response, false);
        return;
      }

      if (mAvail) {
        const available = !!state.val;
        const response = proto === 'ocpp1.6'
          ? await call('ChangeAvailability', { connectorId: 0, type: available ? 'Operative' : 'Inoperative' })
          : await call('ChangeAvailability', { operationalStatus: available ? 'Operative' : 'Inoperative' });
        this._assertCallAccepted('ChangeAvailability', response);
        await succeed('ChangeAvailability', response, available);
        return;
      }

      if (mPhases) {
        const phases = Math.max(1, Math.min(3, Math.round(Number(state.val) || 3)));
        const currentLimit = Math.max(0, Number((await this.getStateAsync(`${identity}.control.chargeLimit`))?.val || 0));
        if (currentLimit <= 0) {
          await succeed('numberOfPhases', { stored: true, profileReapplied: false }, phases);
          return;
        }
        const rawUnit = String((await this.getStateAsync(`${identity}.control.chargeLimitType`))?.val || 'W').trim().toUpperCase();
        const rateUnit = rawUnit === 'A' ? 'A' : 'W';
        const profileCall = this._buildChargingProfileCall(proto, currentLimit, rateUnit, phases);
        const response = await call(profileCall.method, profileCall.payload);
        this._assertCallAccepted(profileCall.method, response);
        await succeed(profileCall.method, response, phases);
        return;
      }

      if (mLimit) {
        const limit = Math.max(0, Number.isFinite(Number(state.val)) ? Number(state.val) : 0);
        const rawUnit = String((await this.getStateAsync(`${identity}.control.chargeLimitType`))?.val || 'W').trim().toUpperCase();
        const rateUnit = rawUnit === 'A' ? 'A' : 'W';
        const phases = Math.max(1, Math.min(3, Math.round(Number((await this.getStateAsync(`${identity}.control.numberOfPhases`))?.val || 3))));
        const profileCall = this._buildChargingProfileCall(proto, limit, rateUnit, phases);
        const response = await call(profileCall.method, profileCall.payload);
        this._assertCallAccepted(profileCall.method, response);
        await succeed(profileCall.method, response, limit);
      }
    } catch (error) {
      await fail(action, error, offlineAckValue, section);
    }
  }

  async onUnload(cb) {
    this._shuttingDown = true;
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    const identities = [...this.runtimeIndex.keys()];
    try {
      if (this.server) await this.server.close();
      for (const identity of identities) {
        try { await this._setDisconnectedHealth(identity, 'adapter-stopped'); } catch (e) { /* best effort during shutdown */ }
      }
    } catch (e) {
      this.log.warn(`NexoWatt OCPP shutdown warning: ${e && e.message || e}`);
    } finally {
      this.server = null;
      cb();
    }
  }
}
if (module && require.main === module) { (() => new NexoWattOcppAdapter())(); }
module.exports = (options) => new NexoWattOcppAdapter(options);
