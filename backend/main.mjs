// Backend of AICW Gadgets.
//
// The bridge runs inside this app as a long job ("bridge"): it registers this computer as an AICW
// relay host (agent.aicoworker.net) and, when enabled, listens on the LAN. Each gadget that
// connects gets its own chat: agent:<agent>:app-<skill>-<mac>. A voice turn is
//   PCM16 16 kHz from the gadget -> WAV -> ctx.host.stt -> the agent -> ctx.host.tts -> PCM16 back.
// "ensureBridge" (schedule + app.ready trigger) restarts it when it is not running.
import crypto from 'node:crypto';
import http from 'node:http';
import { identity, runHost, makeChannel, askHost } from './relay.mjs';
import { RATE, pcmToWav, wavToPcm16, speakable } from './audio.mjs';
import { CATALOG, boardsForUsb, latestRelease, imagesFor } from './firmware.mjs';
import * as ble from './ble.mjs';

const serial = () => import('./serial.mjs'); // native module: loaded only by the USB commands

// The version of the code this process runs: a bridge started by older code hands over to a newer one.
const CODE_VERSION = (() => { try { return JSON.parse(require_fs().readFileSync(new URL('../app.json', import.meta.url), 'utf8')).version || '0'; } catch { return '0'; } })();
function require_fs() { return globalThis.process.getBuiltinModule ? globalThis.process.getBuiltinModule('fs') : null; }
const SKILL = String(process.env.AICW_APP_SKILL || process.env.AICW_SKILL || 'aicw-gadgets-dev').toLowerCase();
const DEFAULTS = { enabled: true, agent: 'main', lan: true, lanPort: 8765, relay: true, open: true, language: 'vi', sttEngine: 'auto', ttsEngine: 'auto' };
const PERSONA = (name) =>
  `[Gadget "${name}" — a push-to-talk voice device. The person speaks; your answer is read aloud on a ` +
  `tiny speaker. Answer in 1-3 short spoken sentences, no markdown, no lists, no links, no emoji.]\n`;

// ---------- settings & devices (one install = one owner's gadgets: shared on purpose) ----------
async function settings(ctx) {
  const saved = (await ctx.store.get('settings')) || {}; // aicw:shared
  // Older versions saved open:false as their default: from v0.1.17 new gadgets are accepted
  // unless the owner turns it off again (marked by openSetByOwner).
  if (saved.open === false && !saved.openSetByOwner) delete saved.open;
  return { ...DEFAULTS, ...saved };
}
async function devices(ctx) {
  return (await ctx.store.get('devices')) || {}; // aicw:shared
}
async function saveDevices(ctx, d) {
  await ctx.store.set('devices', d); // aicw:shared
  await ctx.events.emit('devices', { changed: true }, { to: 'all' });
}
// Every change to the device list goes through here, one at a time, so a turn finishing on the
// bridge and an edit from the page never overwrite each other.
let devLock = Promise.resolve();
function editDevices(ctx, fn) {
  const run = devLock.then(async () => {
    const d = await devices(ctx);
    const out = await fn(d);
    await saveDevices(ctx, d);
    return out;
  });
  devLock = run.catch(() => {});
  return run;
}
function ownerOnly(ctx) {
  if (ctx.user && ctx.user.role && ctx.user.role !== 'owner') throw new Error('only the owner can change gadgets');
}
const normMac = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 12);
const sessionKeyOf = (agent, mac) => `agent:${agent}:app-${SKILL}-${normMac(mac) || 'unknown'}`;

// This computer's keys live in their own files and are written once. They are the connect
// code: if they ever changed, every gadget and setup computer would lose this computer.
// (Kept out of ctx.store: a whole-store write from another process can drop a key.)
async function keyFile(ctx, name, legacyKey) {
  const fs = await import('node:fs'), path = await import('node:path');
  const dir = ctx.dataDir || process.cwd(); // aicw:shared — this computer's own keys, one per computer
  const file = path.join(dir, name);
  try { const hex = fs.readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(hex)) return hex; } catch {}
  let hex = legacyKey ? await ctx.store.get(legacyKey) : null; // aicw:shared — migrate once
  if (!/^[0-9a-f]{64}$/.test(String(hex || ''))) hex = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true }); // aicw:shared
  try { fs.writeFileSync(file, hex, { flag: 'wx' }); } // aicw:shared
  catch { hex = fs.readFileSync(file, 'utf8').trim(); } // another process wrote it first: use that one
  return hex;
}
async function setupIdentity(ctx) { return identity(Buffer.from(await keyFile(ctx, 'setup-identity.hex', 'setupSeed'), 'hex')); }
async function hostIdentity(ctx) { return identity(Buffer.from(await keyFile(ctx, 'host-identity.hex', 'relaySeed'), 'hex')); }
async function newHostIdentity(ctx) {
  const fs = await import('node:fs'), path = await import('node:path');
  fs.writeFileSync(path.join(ctx.dataDir || process.cwd(), 'host-identity.hex'), crypto.randomBytes(32).toString('hex')); // aicw:shared
}
async function askAgent(ctx, agent, mac, text) {
  const out = await ctx.host.tool('sessions_send', { sessionKey: sessionKeyOf(agent, mac), message: text, timeoutSeconds: 180 });
  const d = out?.details || {};
  if (d.status && d.status !== 'ok') throw new Error(d.status === 'timeout' ? 'Agent trả lời quá lâu' : d.error || d.status);
  return String(d.reply ?? '');
}

// ---------- one gadget connection (relay or LAN), speaking PROTOCOL.md ----------
function serveGadget(ctx, ch, via, live) {
  const st = { mac: '', name: '', turn: null, pcm: [], task: null, allowed: false };
  const send = (o) => ch.send(JSON.stringify(o));

  async function runTurn(id, { text, pcm }) {
    const s = await settings(ctx);
    const devs = await devices(ctx);
    const dev = devs[st.mac] || {};
    const agent = dev.agent || s.agent;
    const t0 = Date.now();
    try {
      send({ type: 'sent', id });
      if (text == null) {
        if (!pcm.length || pcm.length < RATE * 2 * 0.3) { send({ type: 'error', id, text: 'Nói ngắn quá' }); return; }
        // The gadget keeps a recording that failed and sends it again later: answer each
        // recording once. Same audio within 10 minutes = the same question.
        const fp = crypto.createHash('sha1').update(pcm).digest('hex');
        const seen = recentTurns.get(st.mac) || new Map();
        for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);
        if (seen.has(fp)) { ctx.log.info(`turn ${id}: same recording again, skipped`); send({ type: 'done', id }); return; }
        seen.set(fp, Date.now()); recentTurns.set(st.mac, seen);
        const f = await ctx.files.put({ name: `turn-${st.mac}-${id}.wav`, data: pcmToWav(pcm), mime: 'audio/wav' });
        try {
          const lang = dev.language || s.language;
          // Speech never stops on one engine: the chosen one first, then this computer's own
          // (Whisper, then Gemma), then whatever else is set up. A cloud quota that ran out,
          // a model pack not downloaded or a provider not signed in just moves to the next one.
          const r = await firstWorking(ctx, 'stt', sttOrder(s.sttEngine), (o) => ctx.host.stt({ file: f.id, language: lang, ...o }));
          text = String(r?.text || '').trim().replace(/^Transcription:\s*/i, '').replace(/^"(.*)"$/s, '$1');
        } finally { ctx.files.remove(f.id).catch(() => {}); }
        if (st.turn !== id) return;
        send({ type: 'heard', id, text, final: true });
        if (!text) { send({ type: 'error', id, text: 'Không nghe rõ' }); return; }
      }
      const reply = await askAgent(ctx, agent, st.mac, PERSONA(dev.name || st.name || 'Dou') + text);
      if (st.turn !== id) return;
      const say = speakable(reply);
      send({ type: 'reply', id, text: say || reply });
      if (say && pcm !== undefined) {
        const voice = dev.voice || s.voice ? { voice: dev.voice || s.voice } : {};
        const tts = await firstWorking(ctx, 'tts', ttsOrder(s.ttsEngine), (o) => ctx.host.tts({ text: say, ...voice, ...o }));
        const wav = await import('node:fs').then((fs) => ctx.files.path(tts.file.id).then((p) => fs.promises.readFile(p)));
        ctx.files.remove(tts.file.id).catch(() => {});
        const out = wavToPcm16(wav, RATE);
        send({ type: 'audio_start', id, rate: RATE, frames: out.length / 2 });
        const CH = 4096;
        for (let i = 0; i < out.length; i += CH) {
          if (st.turn !== id || ch.closed) return;
          ch.send(out.subarray(i, i + CH));
          await new Promise((r) => setTimeout(r, (CH / 2 / RATE) * 800));
        }
        send({ type: 'audio_end', id });
      }
      send({ type: 'done', id });
      await editDevices(ctx, (all) => { if (all[st.mac]) all[st.mac] = { ...all[st.mac], lastTurnAt: Date.now(), lastTurnMs: Date.now() - t0, lastHeard: text?.slice(0, 120), lastError: null }; });
    } catch (e) {
      const why = String(e?.message || e);
      ctx.log.warn(`turn ${id} failed: ${why}`);
      send({ type: 'error', id, text: friendly(e) });
      // Keep the real reason so the app can show it on the gadget's card.
      await editDevices(ctx, (all) => { if (all[st.mac]) all[st.mac] = { ...all[st.mac], lastError: { at: Date.now(), text: friendly(e), detail: why.slice(0, 300) } }; }).catch(() => {});
    }
  }

  ch.onMessage(async (m) => {
    if (Buffer.isBuffer(m)) { if (st.turn != null && st.allowed) st.pcm.push(m); return; }
    let j; try { j = JSON.parse(m); } catch { return; }
    if (j.type === 'setup_hello') {
      // A setup computer linking to this AI host (it pasted this computer's code).
      const id = String(j.id || '').slice(0, 80), name = String(j.name || 'Máy tính').slice(0, 60);
      const links = (await ctx.store.get('setupLinks')) || {}; // aicw:shared
      if (links[id]?.removed) { send({ type: 'setup_refused', text: 'Máy này đã bị ngắt kết nối' }); ch.close(); return; }
      links[id] = { id, name, firstAt: links[id]?.firstAt || Date.now(), lastAt: Date.now() };
      await ctx.store.set('setupLinks', links); // aicw:shared
      ctx.events.emit('links', {}, { to: 'all' });
      send({ type: 'setup_ok', name: await computerName() });
      ch.close(); return;
    }
    if (j.type === 'hello') {
      st.mac = normMac(j.mac) || normMac(ch.id);
      const s = await settings(ctx);
      const verdict = await editDevices(ctx, (devs) => {
        const dev = devs[st.mac];
        if (dev?.blocked) return 'blocked';
        // A gadget only knows this host's address because someone set it up with this
        // computer's connect code: that setup is the consent, so it is accepted right away.
        const isNew = !dev || dev.pending;
        if (isNew && !s.open) {
          // The owner turned auto-accept off: list it and wait for Allow in the app.
          devs[st.mac] = { name: 'Dou ' + st.mac.slice(-4).toUpperCase(), firstSeen: Date.now(), ...dev, mac: st.mac, pending: true, device: j.device, fw: j.fw, lastSeen: Date.now() };
          return 'pending';
        }
        devs[st.mac] = { name: 'Dou ' + st.mac.slice(-4).toUpperCase(), firstSeen: Date.now(), ...dev, mac: st.mac, pending: false, device: j.device, fw: j.fw, via, online: true, lastSeen: Date.now() };
        st.name = devs[st.mac].name;
        return isNew ? 'new' : 'ok';
      });
      if (verdict === 'blocked') { send({ type: 'error', text: 'Thiết bị bị chặn' }); ch.close(); return; }
      if (verdict === 'pending') {
        send({ type: 'error', text: 'Chờ chủ máy cho phép' });
        ctx.host.notify({ title: 'Gadget mới muốn kết nối', body: 'Mở AICW Gadgets để cho phép.' }).catch(() => {});
        ch.close(); return;
      }
      if (verdict === 'new') ctx.host.notify({ title: 'Đã thêm gadget mới', body: `${st.name} vừa kết nối và sẵn sàng trò chuyện.` }).catch(() => {});
      st.allowed = true;
      live.set(st.mac, { via, since: Date.now() });
      send({ type: 'ready', name: st.name });
      return;
    }
    if (!st.allowed) return;
    if (j.type === 'ping') { send({ type: 'pong' }); return; }
    if (j.type === 'turn_begin') { st.turn = j.id; st.pcm = []; return; }
    if (j.type === 'turn_end' && j.id === st.turn) { const pcm = Buffer.concat(st.pcm); st.pcm = []; runTurn(j.id, { pcm }); return; }
    if (j.type === 'text_turn') { st.turn = j.id; runTurn(j.id, { text: j.text || '' }); return; }
    if (j.type === 'cancel' && j.id === st.turn) { st.turn = null; }
  });
  ch.onClose(async () => {
    if (!st.mac) return;
    live.delete(st.mac);
    if (!st.allowed) return;
    await editDevices(ctx, (devs) => { if (devs[st.mac]) devs[st.mac] = { ...devs[st.mac], online: false, lastSeen: Date.now() }; });
  });
}

function friendly(e) {
  const m = String(e?.message || e);
  if (/timeout|quá lâu/i.test(m)) return 'Trợ lý trả lời quá lâu';
  if (/quota|used up|top ?up|Buy more/i.test(m)) return 'Hết lượt nghe giọng nói trên cloud, máy chủ chưa có bộ nghe trên máy';
  if (/model_pack|not installed|missing|not (available|configured)|no (speech|stt)/i.test(m)) return 'Máy chủ chưa có bộ nghe giọng nói';
  if (/tts/i.test(m)) return 'Không đọc được câu trả lời';
  if (/stt|speech|transcri/i.test(m)) return 'Không nghe được';
  return m.slice(0, 60);
}

// ---------- LAN WebSocket server (no dependencies: RFC 6455 framing) ----------
function lanServer(port, onChannel, log) {
  const srv = http.createServer((_q, r) => { r.writeHead(426); r.end('websocket only'); });
  srv.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { sock.destroy(); return; }
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    sock.setNoDelay(true);
    const frame = (op, payload) => {
      const n = payload.length;
      const h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
      sock.write(Buffer.concat([h, payload]));
    };
    const ch = makeChannel(`lan-${req.socket.remoteAddress}`, (pt) => frame(pt[0] === 1 ? 2 : 1, pt.subarray(1)));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 15, masked = buf[1] & 128;
        let len = buf[1] & 127, hl = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); hl = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); hl = 10; }
        if (masked) hl += 4;
        if (buf.length < hl + len) return;
        let p = buf.subarray(hl, hl + len);
        if (masked) { const k = buf.subarray(hl - 4, hl); p = Buffer.from(p.map((b, i) => b ^ k[i & 3])); }
        buf = buf.subarray(hl + len);
        if (op === 1) ch.deliver(p.toString('utf8'));
        else if (op === 2) ch.deliver(Buffer.from(p));
        else if (op === 8) { sock.end(); }
        else if (op === 9) frame(10, p);
      }
    });
    sock.on('close', () => ch.close());
    sock.on('error', () => ch.close());
    onChannel(ch);
  });
  srv.on('error', (e) => log(`LAN server: ${e.message}`));
  srv.listen(port, '0.0.0.0', () => log(`LAN ws://0.0.0.0:${port}/stick`));
  return srv;
}

// ---------- commands ----------
export const commands = {
  async status(_a, ctx) {
    const idn = await hostIdentity(ctx);
    const s = await settings(ctx);
    const b = (await ctx.store.get('bridgeStatus')) || null; // aicw:shared
    const running = b && b.beat && Date.now() - b.beat < 90_000;
    const os = await import('node:os');
    // Real Wi-Fi / Ethernet first; skip VPN (100.64/10), VM bridges and docker-style ranges.
    const skip = (n, a) => /^(utun|tun|tap|bridge|vmnet|vbox|docker|veth|llw|awdl|zt|tailscale|wg)/i.test(n) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^169\.254\./.test(a);
    const ips = Object.entries(os.networkInterfaces()).flatMap(([n, l]) => (l || []).filter((i) => i.family === 'IPv4' && !i.internal && !skip(n, i.address)).map((i) => i.address));
    return { hostId: idn.id, settings: s, bridge: { ...(b || {}), running: !!running }, lanAddresses: ips, codeVersion: CODE_VERSION };
  },

  // ---------- roles: this machine as host, or a setup machine for another host ----------
  async connectCode(_a, ctx) {
    const idn = await hostIdentity(ctx);
    const t = await targetHost(ctx);
    const me = await computerName();
    return { code: CODE_PREFIX + 'relay:' + idn.id + '#' + encodeURIComponent(me), me, target: { ...t, label: t.self ? me : t.label } };
  },
  async setTarget(a, ctx) {
    ownerOnly(ctx);
    if (!a.code) { await ctx.store.delete('targetHost'); return { target: await targetHost(ctx) }; } // aicw:shared
    const host = parseConnectCode(a.code);
    const idn = await hostIdentity(ctx);
    const self = host === 'relay:' + idn.id;
    let hostName = '';
    if (!self && host.startsWith('relay:')) {
      // Introduce this computer to the AI host: it shows up there and can be disconnected.
      try {
        const sid = await setupIdentity(ctx);
        const hello = { type: 'setup_hello', id: sid.id, name: await computerName() };
        let r;
        try { r = await askHost(sid, host.slice(6), hello, { timeoutMs: 15000 }); }
        catch (e1) { ctx.log.warn('askHost try 1: ' + e1.message); await new Promise((x) => setTimeout(x, 1500)); r = await askHost(sid, host.slice(6), hello, { timeoutMs: 25000 }); }
        if (r.type === 'setup_refused') throw new Error('Máy kia đã ngắt kết nối với máy này. Trên máy kia, kết nối lại trong AICW Gadgets.');
        hostName = r.name || '';
      } catch (e) {
        ctx.log.warn('askHost: ' + (e?.stack || e));
        if (/offline/.test(e.message)) throw new Error('Không liên lạc được với máy kia. Kiểm tra máy đó đang mở AICoworker và AICW Gadgets đang bật kết nối.');
        throw e;
      }
    }
    const t = self ? null : { host, label: String(a.label || hostName || nameInCode(a.code) || 'Máy tính khác').slice(0, 60), at: Date.now() };
    if (t) await ctx.store.set('targetHost', t); else await ctx.store.delete('targetHost'); // aicw:shared
    return { target: await targetHost(ctx) };
  },

  async setupLinks(_a, ctx) {
    const links = (await ctx.store.get('setupLinks')) || {}; // aicw:shared
    return { links: Object.values(links).filter((l) => !l.removed).sort((a, b) => b.lastAt - a.lastAt) };
  },
  async removeSetupLink({ id }, ctx) {
    ownerOnly(ctx);
    const links = (await ctx.store.get('setupLinks')) || {}; // aicw:shared
    if (links[id]) links[id] = { ...links[id], removed: Date.now() };
    await ctx.store.set('setupLinks', links); // aicw:shared
    return { ok: true };
  },
  async rotateCode(_a, ctx) {
    // New code for this computer: the old one stops working, so every setup computer and
    // every gadget that used it is removed (they must be set up again with the new code).
    ownerOnly(ctx);
    await newHostIdentity(ctx);
    await ctx.store.set('setupLinks', {}); // aicw:shared
    await editDevices(ctx, (d) => { for (const k of Object.keys(d)) delete d[k]; });
    await ctx.store.set('restartBridge', Date.now()); // aicw:shared
    const idn = await hostIdentity(ctx);
    return { ok: true, code: CODE_PREFIX + 'relay:' + idn.id + '#' + encodeURIComponent(await computerName()) };
  },

  // ---------- Bluetooth setup (gadget already has AICW firmware) ----------
  async bleScan(a, ctx) {
    ownerOnly(ctx);
    const list = await ble.scan(Math.min(Math.max(Number(a.seconds) || 6, 2), 20) * 1000);
    return { gadgets: list };
  },
  async bleSetup(a, ctx) {
    ownerOnly(ctx);
    const t = await targetHost(ctx);
    const host = a.code ? parseConnectCode(a.code) : t.host;
    const jobId = ctx.job?.id || crypto.randomUUID();
    // A setup still waiting for an answer from an older page is over: let it end.
    for (const [k, res] of bleAnswers) { if (k !== jobId) { res(null); bleAnswers.delete(k); } }
    const steps = [];
    const r = await ble.setup(a.id, { ssid: a.ssid, password: a.password, host }, (st) => {
      steps.push(st.step);
      const pct = { connecting: 0.05, pairing_confirm_required: 0.15, pairing_confirmed: 0.35, wifi_scan: 0.4, wifi_connecting: 0.55, wifi_connected: 0.8, auth_ok: 1 }[st.step];
      // The note is capped at 400 chars: keep it small, the Wi-Fi list goes in data.
      ctx.job?.progress(pct ?? 0.5, JSON.stringify({ step: st.step, text: String(st.text || '').slice(0, 120) }), st.networks ? { networks: st.networks.slice(0, 20) } : undefined);
    }, async (q) => {
      // Ask the page for the Wi-Fi again; it answers with bleAnswer (same job id).
      ctx.job?.progress(0.5, JSON.stringify({ step: 'need_wifi', reason: q.reason, ssid: String(q.ssid || '').slice(0, 40), at: Date.now() }), { networks: (q.networks || []).slice(0, 20) });
      const ans = await new Promise((resolve) => { bleAnswers.set(jobId, resolve); setTimeout(() => resolve(null), 120000); });
      bleAnswers.delete(jobId);
      return ans;
    });
    if (t.self) {
      const mac = normMac(r.device?.mac);
      if (mac) await editDevices(ctx, (d) => { d[mac] = { ...(d[mac] || {}), mac, name: d[mac]?.name || 'Dou ' + mac.slice(-4), pending: false, blocked: false, setupVia: 'ble', firstSeen: d[mac]?.firstSeen || Date.now() }; });
    }
    return { ok: true, device: r.device, host, ssid: r.ssid, self: !!t.self };
  },
  async bleAnswer(a, ctx) {
    ownerOnly(ctx);
    const res = bleAnswers.get(String(a.job || ''));
    if (!res) throw new Error('Không còn phiên cài đặt nào đang chờ');
    res(a.cancel ? null : { ssid: String(a.ssid || ''), password: String(a.password || '') });
    return { ok: true };
  },

  async agents(_a, ctx) {
    ownerOnly(ctx);
    let ids = [];
    try {
      const out = await ctx.host.tool('agents_list', {});
      const list = out?.details?.agents || out?.details || [];
      ids = (Array.isArray(list) ? list : []).map((a) => (typeof a === 'string' ? { id: a, name: a } : { id: a.id, name: a.name || a.identity?.name || a.id })).filter((a) => a.id);
    } catch (e) { ctx.log.warn('agents_list: ' + (e?.message || e)); }
    if (!ids.some((a) => a.id === 'main')) ids.unshift({ id: 'main', name: 'main' });
    return { agents: ids };
  },

  async listDevices(_a, ctx) {
    const d = await devices(ctx);
    return { devices: Object.values(d).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)) };
  },

  async updateDevice({ mac, name, agent, blocked, pending, voice, language }, ctx) {
    ownerOnly(ctx);
    const k = normMac(mac);
    const patch = {};
    if (name !== undefined) patch.name = String(name).slice(0, 40) || 'Dou';
    if (agent !== undefined) patch.agent = String(agent).slice(0, 64) || undefined;
    if (blocked !== undefined) patch.blocked = !!blocked;
    if (pending !== undefined) patch.pending = !!pending;
    if (voice !== undefined) patch.voice = String(voice).slice(0, 64) || undefined;
    if (language !== undefined) patch.language = String(language).slice(0, 8) || undefined;
    return editDevices(ctx, (d) => {
      if (!d[k]) throw new Error('không có gadget này');
      d[k] = { ...d[k], ...patch };
      return { device: d[k] };
    });
  },

  async removeDevice({ mac }, ctx) {
    ownerOnly(ctx);
    const k = normMac(mac);
    return editDevices(ctx, (d) => { delete d[k]; return { removed: k }; });
  },

  async updateSettings(patch, ctx) {
    ownerOnly(ctx);
    const s = { ...(await settings(ctx)) };
    for (const k of ['enabled', 'agent', 'lan', 'lanPort', 'relay', 'open', 'language', 'voice', 'sttEngine', 'ttsEngine']) if (patch[k] !== undefined) s[k] = patch[k];
    if (patch.open !== undefined) s.openSetByOwner = true;
    s.lanPort = Math.max(1024, Math.min(65535, Number(s.lanPort) || 8765));
    await ctx.store.set('settings', s); // aicw:shared
    await ctx.store.set('restartBridge', Date.now()); // aicw:shared — the running bridge picks up the new settings
    return { settings: s };
  },

  async channelHistory({ mac, limit = 30 }, ctx) {
    const d = await devices(ctx), dev = d[normMac(mac)];
    const s = await settings(ctx);
    const key = sessionKeyOf(dev?.agent || s.agent, mac);
    const out = await ctx.host.tool('sessions_history', { sessionKey: key, limit: Math.min(Number(limit) || 30, 100) });
    const msgs = (out?.details?.messages || []).map((m) => ({
      role: m.role,
      text: (typeof m.content === 'string' ? m.content : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')).replace(/^\[Gadget[^\]]*\]\n/, ''),
      at: m.timestamp,
    })).filter((m) => m.text && (m.role === 'user' || m.role === 'assistant'));
    return { sessionKey: key, messages: msgs };
  },


  // ---------- USB: find, flash and set up a gadget ----------
  async usbPorts(_a, ctx) {
    ownerOnly(ctx);
    const ports = await (await serial()).listPorts();
    return { ports: ports.map((p) => ({ ...p, boards: boardsForUsb(p.usb).map((b) => b.id) })) };
  },

  async boards(_a, ctx) {
    let release = null, error = null;
    try { release = await latestRelease(ctx); } catch (e) { error = String(e?.message || e); }
    const has = release?.manifest?.boards || {};
    return {
      boards: CATALOG.boards.map((b) => ({ id: b.id, name: b.name, chip: b.chip, usb: b.usb, aicw: b.aicw, available: !!has[b.id] })),
      release: release ? { tag: release.tag, publishedAt: release.publishedAt, prerelease: release.prerelease } : null,
      error,
    };
  },

  async gadgetStatus({ port }, ctx) {
    ownerOnly(ctx);
    const lines = await (await serial()).consoleCommand(port, ['aicw_status', 'status'], { waitFor: ['@aicw_status'], timeoutMs: 6000 });
    const pick = (tag) => { const l = lines.find((x) => x.startsWith(tag + ' ')); if (!l) return null; try { return JSON.parse(l.slice(tag.length + 1)); } catch { return l.slice(tag.length + 1); } };
    const gadget = pick('@aicw_status');
    return { firmware: gadget ? 'aicw' : lines.length ? 'other' : 'unknown', gadget, status: pick('@status'), lines };
  },

  async setupGadget({ port, ssid, password, host, useThisComputer = true }, ctx) {
    ownerOnly(ctx);
    const ser = await serial();
    const out = {};
    if (ssid) {
      const r = await ser.consoleCommand(port, [`wifi=${ssid}\t${password || ''}`], { waitFor: ['@wifi'], timeoutMs: 8000 });
      out.wifi = r.find((l) => l.startsWith('@wifi')) || 'no answer';
    }
    if (!host && useThisComputer) host = 'relay:' + (await hostIdentity(ctx)).id;
    if (host) {
      const r = await ser.consoleCommand(port, [`aicw_host=${host}`], { waitFor: ['@aicw_host'], timeoutMs: 6000 });
      out.host = r.find((l) => l.startsWith('@aicw_host')) || 'no answer';
    }
    await new Promise((r) => setTimeout(r, 6000));
    const st = await ser.consoleCommand(port, ['aicw_status'], { waitFor: ['@aicw_status'], timeoutMs: 8000 });
    const l = st.find((x) => x.startsWith('@aicw_status '));
    try { out.status = JSON.parse(l.slice(13)); } catch { out.status = l || null; }
    // remember the gadget now, so it is allowed when it connects
    if (out.status) {
      const ports = await ser.listPorts();
      const mac = normMac(ports.find((p) => p.path === port)?.serial);
      if (mac) {
        await editDevices(ctx, (d) => { d[mac] = { name: 'Dou', firstSeen: Date.now(), ...d[mac], mac, pending: false, blocked: false }; });
        out.mac = mac;
      }
    }
    return out;
  },

  async rebootGadget({ port }, ctx) {
    ownerOnly(ctx);
    return (await serial()).rebootGadget(port);
  },

  async gadgetLog({ port, seconds = 6 }, ctx) {
    ownerOnly(ctx);
    const text = await (await serial()).readLog(port, Math.min(Math.max(Number(seconds) || 6, 1), 20) * 1000);
    return { text: text.slice(-8000) };
  },

  async flashGadget({ port, board, localBuild }, ctx) {
    ownerOnly(ctx);
    const b = CATALOG.boards.find((x) => x.id === board);
    if (!b) throw new Error('Không có bo mạch này trong danh sách');
    ctx.job?.progress(0.02, 'Đang tải firmware…');
    const { version, images } = await imagesFor(ctx, board, { localBuild });
    ctx.job?.progress(0.05, `Firmware ${version}: đang kết nối bo mạch…`);
    const ser = await serial();
    let chipLine = '';
    const r = await ser.flash(port, images, {
      onProgress: (f, t) => {
        if (f != null) ctx.job?.progress(0.05 + f * 0.9, `Đang nạp ${Math.round(f * 100)}%`);
        else if (/Chip is/.test(t)) chipLine = t.trim();
      },
    });
    if (b.chip && !String(r.chip || '').toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(b.chip.replace(/[^a-z0-9]/g, ''))) {
      ctx.log.warn(`flashed ${board} (${b.chip}) onto ${r.chip}`);
    }
    ctx.job?.progress(0.97, 'Đang khởi động lại…');
    await new Promise((res) => setTimeout(res, 6000));
    const mac = normMac(r.mac);
    if (mac) await editDevices(ctx, (d) => { d[mac] = { name: 'Dou', firstSeen: Date.now(), ...d[mac], mac, board, fwVersion: version, flashedAt: Date.now(), pending: false }; });
    return { board, version, chip: r.chip || chipLine, mac };
  },

  async probeAgent({ text = 'Trả lời đúng một chữ: OK', agent = 'main', mac = 'probe' }, ctx) {
    const t0 = Date.now();
    const reply = await askAgent(ctx, agent, mac, text);
    return { reply, ms: Date.now() - t0, sessionKey: sessionKeyOf(agent, mac) };
  },

  // Arm the keep-alive timer (every 15 min the bridge is started if it is not running).
  async arm(_a, ctx) {
    ownerOnly(ctx);
    await ctx.triggers.arm('keepalive', { every: '15m', key: 'bridge' });
    return { armed: true };
  },

  async stopBridge(_a, ctx) {
    ownerOnly(ctx);
    const s = await settings(ctx);
    await ctx.store.set('settings', { ...s, enabled: false }); // aicw:shared
    await ctx.store.set('stopBridge', Date.now()); // aicw:shared
    return { stopping: true };
  },

  async startBridge(_a, ctx) {
    ownerOnly(ctx);
    const s = await settings(ctx);
    await ctx.store.set('settings', { ...s, enabled: true }); // aicw:shared
    return { enabled: true };
  },

  async restartBridge(_a, ctx) {
    ownerOnly(ctx);
    const at = Date.now();
    await ctx.store.set('restartBridge', at); // aicw:shared
    return { restarting: true, at };
  },

  // The bridge itself. Started by the app.ready trigger, the keep-alive timer or the page.
  // Exits at once when another bridge is alive; picks up new settings in place; stops after 5.5 h
  // (the keep-alive timer starts the next one).
  async bridge(_a, ctx) {
    if ((await settings(ctx)).enabled === false) return { disabled: true };
    // Re-arm the 15-minute keep-alive every time: a job lives at most 6 h, and the
    // timer is what starts the next one (arming the same key again just replaces it).
    await ctx.triggers?.arm?.('keepalive', { every: '15m', key: 'bridge' }).catch((e) => ctx.log.warn('keepalive arm: ' + e.message));
    // Another bridge alive? Its heartbeat is every 10 s: wait 25 s and look again, so a bridge
    // that is just being stopped (or was killed) does not keep the new one from starting.
    const alive = async () => { const b = (await ctx.store.get('bridgeStatus')) || {}; return b.beat && Date.now() - b.beat < 22_000 ? b : null; }; // aicw:shared
    const first = await alive();
    if (first && first.version === CODE_VERSION) {
      await new Promise((r) => setTimeout(r, 25_000));
      const again = await alive();
      if (again && again.beat !== first.beat) return { alreadyRunning: true };
    } else if (first) {
      // A bridge from an older version of the app is running: take over. Claiming bridgeStatus
      // makes it stop within ~10 s; wait for that before opening the same relay identity.
      ctx.log.info(`bridge ${first.version || '?'} -> ${CODE_VERSION}: taking over`);
      await ctx.store.set('bridgeStatus', { ...first, pid: 'upgrade:' + CODE_VERSION, beat: Date.now(), version: CODE_VERSION }); // aicw:shared
      await new Promise((r) => setTimeout(r, 14_000));
    }
    const me = process.pid + ':' + (ctx.job?.id || crypto.randomUUID());
    let idn = await hostIdentity(ctx);
    const startedAt = Date.now();
    const live = new Map();
    const log = (...x) => ctx.log.info(x.join(' '));
    const outer = new AbortController();
    ctx.signal?.addEventListener('abort', () => outer.abort(), { once: true });
    const stop0 = (await ctx.store.get('stopBridge')) || 0; // aicw:shared
    let restartMark = (await ctx.store.get('restartBridge')) || 0; // aicw:shared
    while (!outer.signal.aborted) {
      idn = await hostIdentity(ctx); // a new code (rotateCode) takes effect on restart
      const s = await settings(ctx);
      const ac = new AbortController();
      outer.signal.addEventListener('abort', () => ac.abort(), { once: true });
      let relay = s.relay ? 'connecting' : 'off', lan = s.lan ? 'starting' : 'off';
      const loopAt = Date.now();
      const beat = async () => {
        await ctx.store.set('bridgeStatus', { beat: Date.now(), pid: me, version: CODE_VERSION, startedAt, loopAt, hostId: idn.id, relay, lan, lanPort: s.lanPort, online: [...live.keys()] }); // aicw:shared
        ctx.events.emit('bridge', { relay, lan, online: live.size }, { to: 'all' });
      };
      const onChannel = (via) => (ch) => serveGadget(ctx, ch, via, live);
      const srv = s.lan ? lanServer(s.lanPort, onChannel('lan'), (m) => { lan = m.startsWith('LAN ws') ? 'up' : 'error: ' + m; log(m); void beat(); }) : null;
      const relayRun = s.relay
        ? runHost(idn, { signal: ac.signal, log, onGuest: onChannel('relay'), onStatus: (x) => { relay = x.relay; void beat(); } })
        : Promise.resolve();
      while (!ac.signal.aborted) {
        await beat();
        ctx.job?.progress(0, `relay ${relay} · LAN ${lan} · ${live.size} online`);
        await new Promise((r) => { const t = setTimeout(r, 10000); ac.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
        if (ac.signal.aborted) break;
        const stop = (await ctx.store.get('stopBridge')) || 0; // aicw:shared
        const restart = (await ctx.store.get('restartBridge')) || 0; // aicw:shared
        const owner = ((await ctx.store.get('bridgeStatus')) || {}).pid; // aicw:shared
        if (stop > stop0 || Date.now() - startedAt > 5.5 * 3600_000 || (owner && owner !== me)) outer.abort();
        else if (restart > restartMark) { restartMark = restart; ac.abort(); }
      }
      if (srv) await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); setTimeout(r, 3000); });
      await relayRun.catch(() => {});
    }
    const cur = (await ctx.store.get('bridgeStatus')) || {}; // aicw:shared
    if (cur.pid === me) await ctx.store.set('bridgeStatus', { beat: 0, stoppedAt: Date.now(), hostId: idn.id }); // aicw:shared
    ctx.events.emit('bridge', { relay: 'off', lan: 'off', online: 0 }, { to: 'all' });
    return { stopped: true };
  },
};
