// AICW relay link (agent.aicoworker.net) — Node port of bridge/aicw_relay.py.
// Same wire format as AICoworker's sharedwebchat relay (relay-protocol.ts / e2ee.ts):
//   host  : wss://<relay>/h        guest: wss://<relay>/g/<hostId>
//   hello(0x01)+challenge -> auth(0x02) signed with Ed25519 -> authOK(0x03)
//   relay -> host : 0x11 + guestPub(32) + inner     host -> guest : 0x12 + guestPub + inner
//   inner = E2EE handshake (0x01 init / 0x02 resp) then 0x03 + nonce(12) + AES-256-GCM
// Inside a session each plaintext is 0x00 + JSON text or 0x01 + binary (PCM16).
import crypto from 'node:crypto';

export const RELAY = process.env.AICW_RELAY || 'wss://agent.aicoworker.net';
const F = { HELLO: 1, AUTH: 2, AUTHOK: 3, AUTHERR: 4, RECV: 0x11, TOGUEST: 0x12, GUESTGONE: 0x21, PING: 0x40, PONG: 0x41 };
const ROLE_HOST = 1;
const CI = 'aicw-e2ee-v1/init', CR = 'aicw-e2ee-v1/resp', INFO = 'aicw-e2ee-v1', RA = 'aicw-relay-auth-v1';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function b32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
const sha = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))))).digest();

// Ed25519 identity from a 32-byte seed (PKCS8 wrapper, no libraries).
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
export function identity(seed) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { seed, priv, pub, id: b32(pub), sign: (m) => crypto.sign(null, m, priv) };
}
const edVerify = (pub, sig, m) => {
  try { return crypto.verify(null, m, crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, pub]), format: 'der', type: 'spki' }), sig); } catch { return false; }
};

class Session {
  constructor(ss, guestEph, hostEph) {
    const okm = Buffer.from(crypto.hkdfSync('sha256', ss, Buffer.concat([guestEph, hostEph]), INFO, 64));
    this.tx = okm.subarray(32, 64); // host -> guest
    this.rx = okm.subarray(0, 32);  // guest -> host
    this.sc = 0n; this.rc = 0n;
  }
  nonce(c, dir) { const n = Buffer.alloc(12); n[0] = dir; for (let i = 11; i >= 1 && c > 0n; i--, c >>= 8n) n[i] = Number(c & 255n); return n; }
  enc(pt) {
    const n = this.nonce(this.sc++, 1);
    const c = crypto.createCipheriv('aes-256-gcm', this.tx, n);
    const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    return Buffer.concat([Buffer.from([3]), n, ct]);
  }
  dec(fr) {
    if (fr.length < 29 || fr[0] !== 3) throw new Error('bad frame');
    const n = fr.subarray(1, 13);
    if (!n.equals(this.nonce(this.rc, 0))) throw new Error('out of order');
    const body = fr.subarray(13), tag = body.subarray(body.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', this.rx, n);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
    this.rc++;
    return pt;
  }
}

/**
 * Keep a relay host registration alive until `signal` aborts.
 * onGuest(channel) is called per guest; channel = { id, send(str|Buffer), onMessage(fn), onClose(fn) }.
 */
export async function runHost(idn, { onGuest, log, onStatus, signal }) {
  const host = new URL(RELAY).host;
  let delay = 1000;
  while (!signal?.aborted) {
    const guests = new Map();
    await new Promise((resolve) => {
      const ws = new WebSocket(RELAY.replace(/\/+$/, '') + '/h');
      ws.binaryType = 'arraybuffer';
      const send = (b) => { try { ws.send(b); } catch {} };
      const stop = () => { try { ws.close(); } catch {} };
      signal?.addEventListener('abort', stop, { once: true });
      ws.onmessage = (ev) => {
        const data = Buffer.from(ev.data);
        const t = data[0], body = data.subarray(1);
        if (t === F.HELLO) {
          const sig = idn.sign(sha(RA, Buffer.from([0]), host, Buffer.from([0]), body.subarray(1, 33), Buffer.from([ROLE_HOST]), idn.pub, Buffer.alloc(32)));
          send(Buffer.concat([Buffer.from([F.AUTH, ROLE_HOST]), idn.pub, Buffer.alloc(32), sig]));
        } else if (t === F.AUTHOK) {
          delay = 1000; onStatus?.({ relay: 'up', hostId: idn.id }); log?.('relay host up', idn.id);
        } else if (t === F.AUTHERR) {
          onStatus?.({ relay: 'refused', error: body.toString() }); log?.('relay refused', body.toString()); stop();
        } else if (t === F.PING) {
          send(Buffer.concat([Buffer.from([F.PONG]), body]));
        } else if (t === F.GUESTGONE) {
          const g = guests.get(b32(body.subarray(0, 32)));
          if (g) { guests.delete(g.id); g.close(); }
        } else if (t === F.RECV && body.length > 32) {
          const gp = body.subarray(0, 32), inner = body.subarray(32), gid = b32(gp);
          if (inner[0] === 1) {
            if (inner.length !== 130 || !inner.subarray(2, 34).equals(gp)) return;
            const geph = inner.subarray(34, 66);
            if (!edVerify(gp, inner.subarray(66, 130), sha(CI, idn.pub, gp, geph))) return;
            const eph = crypto.generateKeyPairSync('x25519');
            const ephp = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
            const ss = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([X_SPKI, geph]), format: 'der', type: 'spki' }) });
            const sess = new Session(ss, geph, ephp);
            const sig = idn.sign(sha(CR, idn.pub, gp, geph, ephp));
            guests.get(gid)?.close();
            const ch = makeChannel(gid, (pt) => send(Buffer.concat([Buffer.from([F.TOGUEST]), gp, sess.enc(pt)])));
            ch.sess = sess;
            guests.set(gid, ch);
            send(Buffer.concat([Buffer.from([F.TOGUEST]), gp, Buffer.from([2, 1]), ephp, sig]));
            log?.('relay guest up', gid.slice(0, 8));
            onGuest(ch);
          } else {
            const ch = guests.get(gid);
            if (!ch) return;
            try {
              const pt = ch.sess.dec(inner);
              ch.deliver(pt[0] === 1 ? pt.subarray(1) : pt.subarray(1).toString('utf8'));
            } catch (e) { log?.('decrypt', String(e)); }
          }
        }
      };
      ws.onclose = () => { for (const g of guests.values()) g.close(); resolve(); };
      ws.onerror = () => {};
    });
    if (signal?.aborted) break;
    onStatus?.({ relay: 'reconnecting' });
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 60000);
  }
}

export function makeChannel(id, rawSend) {
  const handlers = { msg: [], close: [] };
  let closed = false;
  return {
    id,
    get closed() { return closed; },
    send(m) { if (closed) return; rawSend(Buffer.isBuffer(m) ? Buffer.concat([Buffer.from([1]), m]) : Buffer.concat([Buffer.from([0]), Buffer.from(m)])); },
    onMessage(fn) { handlers.msg.push(fn); },
    onClose(fn) { handlers.close.push(fn); },
    deliver(m) { for (const f of handlers.msg) f(m); },
    close() { if (closed) return; closed = true; for (const f of handlers.close) f(); },
  };
}

const G = { TOHOST: 0x10, FROMHOST: 0x13, HOSTGONE: 0x22 };
const ROLE_GUEST = 2;
/**
 * Connect to a host as a guest (a setup computer talking to an AI host), send `hello`
 * and resolve with the host's first JSON answer. Throws 'offline' when the host is not there.
 */
export async function askHost(idn, hostId, hello, { timeoutMs = 15000 } = {}) {
  const host = new URL(RELAY).host;
  const hpub = b32d(hostId);
  const ws = new WebSocket(RELAY.replace(/\/+$/, '') + '/g/' + hostId);
  ws.binaryType = 'arraybuffer';
  const eph = crypto.generateKeyPairSync('x25519');
  const ephp = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const init = Buffer.concat([Buffer.from([1, 1]), idn.pub, ephp, idn.sign(sha(CI, hpub, idn.pub, ephp))]);
  let sess = null;
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('offline')), timeoutMs);
      const done = (fn, v) => { clearTimeout(t); fn(v); };
      ws.onerror = () => done(reject, new Error('offline'));
      ws.onclose = () => done(reject, new Error('offline'));
      ws.onmessage = (ev) => {
        const data = Buffer.from(ev.data), ty = data[0], body = data.subarray(1);
        if (ty === F.HELLO) ws.send(Buffer.concat([Buffer.from([F.AUTH, ROLE_GUEST]), idn.pub, hpub, idn.sign(sha(RA, Buffer.from([0]), host, Buffer.from([0]), body.subarray(1, 33), Buffer.from([ROLE_GUEST]), idn.pub, hpub))]));
        else if (ty === F.AUTHOK) ws.send(Buffer.concat([Buffer.from([G.TOHOST]), init]));
        else if (ty === F.AUTHERR || ty === G.HOSTGONE) done(reject, new Error('offline'));
        else if (ty === F.PING) ws.send(Buffer.concat([Buffer.from([F.PONG]), body]));
        else if (ty === G.FROMHOST && !sess) {
          if (body[0] !== 2) return done(reject, new Error('refused'));
          const hephp = body.subarray(2, 34);
          if (!edVerify(hpub, body.subarray(34, 98), sha(CR, hpub, idn.pub, ephp, hephp))) return done(reject, new Error('bad host signature'));
          const ss = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([X_SPKI, hephp]), format: 'der', type: 'spki' }) });
          sess = new GuestSession(ss, ephp, hephp);
          ws.send(Buffer.concat([Buffer.from([G.TOHOST]), sess.enc(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(hello))]))]));
        } else if (ty === G.FROMHOST && sess) {
          try { const pt = sess.dec(body); if (pt[0] === 0) done(resolve, JSON.parse(pt.subarray(1).toString('utf8'))); } catch (e) { done(reject, e); }
        }
      };
    });
  } finally { try { ws.close(); } catch {} }
}
function b32d(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(s).toLowerCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
class GuestSession extends Session {
  constructor(ss, guestEph, hostEph) { super(ss, guestEph, hostEph); [this.tx, this.rx] = [this.rx, this.tx]; }
  enc(pt) { const n = this.nonce(this.sc++, 0); const c = crypto.createCipheriv('aes-256-gcm', this.tx, n); return Buffer.concat([Buffer.from([3]), n, c.update(pt), c.final(), c.getAuthTag()]); }
  dec(fr) { const n = fr.subarray(1, 13); if (!n.equals(this.nonce(this.rc, 1))) throw new Error('out of order'); const body = fr.subarray(13); const d = crypto.createDecipheriv('aes-256-gcm', this.rx, n); d.setAuthTag(body.subarray(body.length - 16)); const pt = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]); this.rc++; return pt; }
}
