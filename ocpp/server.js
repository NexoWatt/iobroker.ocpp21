'use strict';
const { RPCServer, createRPCError } = require('ocpp-rpc');
const { registerHandlers: register16 } = require('./v16');
const { registerHandlers: register201 } = require('./v201');
const { registerHandlers: register21 } = require('./v21');
class OcppRpcServer {
  constructor(ctx, opts) {
    this.ctx = ctx; this.opts = opts;
    this.server = new RPCServer({ protocols: opts.protocols, strictMode: opts.strictMode ?? true, respondWithDetailedErrors: false });
    this.server.on('error', (err) => this.ctx.log.error(`RPCServer error: ${err && err.stack || err}`));
    this.server.auth((accept, reject, handshake) => {
      try {
        const identity = handshake && handshake.identity;
        if (!identity) return reject(401, 'Missing identity in URL');
        if (this.ctx.config.identityAllowlist && this.ctx.config.identityAllowlist.length) {
          const ok = this.ctx.config.identityAllowlist.includes(identity);
          if (!ok) return reject(403, 'Identity not allowed');
        }
        accept({ session: { connectedAt: Date.now(), identity } });
      } catch (e) { reject(500, 'auth error'); }
    });
    this.server.on('client', (client) => this.onClient(client));
  }
  async listen() {
    await this.server.listen(this.opts.port, this.opts.host || '0.0.0.0');
    this.ctx.log.info(`OCPP server listening on ${(this.opts.host || '0.0.0.0')}:${this.opts.port} for ${this.opts.protocols.join(', ')}`);
  }
  async close() { await this.server.close(); }
  onClient(client) {
    const proto = client.protocol; const identity = client.identity;
    this.ctx.log.info(`Client connected: ${identity} via ${proto}`);
    this.ctx.runtime.indexClient(identity, proto, client);
    client.handle(({ method }) => { this.ctx.log.warn(`Unhandled ${proto} method '${method}' from ${identity}`); throw createRPCError('NotImplemented'); });
    if (proto === 'ocpp1.6') register16(client, this.ctx);
    if (proto === 'ocpp2.0.1') register201(client, this.ctx);
    if (proto === 'ocpp2.1') register21(client, this.ctx);
    client.on('close', () => { this.ctx.runtime.unindexClient(identity); this.ctx.states.setConnection(identity, false).catch(()=>{}); this.ctx.log.info(`Client closed: ${identity}`); });
    this.ctx.states.setConnection(identity, true).catch(()=>{});
  }
}
module.exports = { OcppRpcServer };
