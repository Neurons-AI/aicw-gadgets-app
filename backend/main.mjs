// Backend of AICW Gadgets.
//
// The bridge runs inside this app as a long job ("bridge"): it registers this computer as an AICW
// relay host (agent.aicoworker.net) and, when enabled, listens on the LAN. Each gadget that
// connects gets its own chat: agent:<agent>:app-<skill>-<mac>. A voice turn is
//   PCM16 16 kHz from the gadget -> WAV -> ctx.host.stt -> the agent -> ctx.host.tts -> PCM16 back.
// "ensureBridge" (schedule + app.ready trigger) restarts it when it is not running.
import crypto from 'node:crypto';
import http from 'node:http';
import { identity, runHost, makeChannel } from './relay.mjs';
import { RATE, pcmToWav, wavToPcm16, speakable } from './audio.mjs';
import { CATALOG, boardsForUsb, latestRelease, imagesFor } from './firmware.mjs';

const serial = () => import('./serial.mjs'); // native module: loaded only by the USB commands

const SKILL = String(process.env.AICW_APP_SKILL || process.env.AICW_SKILL || 'aicw-gadgets-dev').toLowerCase();
const DEFAULTS = { enabled: true, agent: 'main', lan: true, lanPort: 8765, relay: true, open: false, language: 'vi', sttEngine: 'auto', ttsEngine: 'auto' };
const PERSONA = (name) =>
  `[Gadget "${name}" — a push-to-talk voice device. The person speaks; your answer is read aloud on a ` +
  `tiny speaker. Answer in 1-3 short spoken sentences, no markdown, no lists, no links, no emoji.]\n`;

// ---------- settings & devices (one install = one owner's gadgets: shared on purpose) ----------
async function settings(ctx) {
  return { ...DEFAULTS, ...((await ctx.store.get('settings')) || {}) }; // aicw:shared
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

async function hostIdentity(ctx) {
  let seed = await ctx.store.get('relaySeed'); // aicw:shared — this computer's bridge identity
  if (!seed) { seed = crypto.randomBytes(32).toString('hex'); await ctx.store.set('relaySeed', seed); } // aicw:shared
  return identity(Buffer.from(seed, 'hex'));
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
        const f = await ctx.files.put({ name: `turn-${st.mac}-${id}.wav`, data: pcmToWav(pcm), mime: 'audio/wav' });
        try {
          const r = await ctx.host.stt({ file: f.id, language: dev.language || s.language, engine: s.sttEngine || 'auto' });
          text = String(r?.text || '').trim();
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
        const tts = await ctx.host.tts({ text: say, engine: s.ttsEngine || 'auto', ...(dev.voice || s.voice ? { voice: dev.voice || s.voice } : {}) });
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
      await editDevices(ctx, (all) => { if (all[st.mac]) all[st.mac] = { ...all[st.mac], lastTurnAt: Date.now(), lastTurnMs: Date.now() - t0, lastHeard: text?.slice(0, 120) }; });
    } catch (e) {
      ctx.log.warn(`turn ${id} failed: ${e?.message || e}`);
      send({ type: 'error', id, text: friendly(e) });
    }
  }

  ch.onMessage(async (m) => {
    if (Buffer.isBuffer(m)) { if (st.turn != null && st.allowed) st.pcm.push(m); return; }
    let j; try { j = JSON.parse(m); } catch { return; }
    if (j.type === 'hello') {
      st.mac = normMac(j.mac) || normMac(ch.id);
      const s = await settings(ctx);
      const verdict = await editDevices(ctx, (devs) => {
        const dev = devs[st.mac];
        if (dev?.blocked) return 'blocked';
        if (dev?.pending || (!dev && !s.open)) {
          // unknown gadget: list it as pending so the owner can allow it in the app
          devs[st.mac] = { name: 'Dou mới', firstSeen: Date.now(), ...dev, mac: st.mac, pending: true, device: j.device, fw: j.fw, lastSeen: Date.now() };
          return dev ? 'pending' : 'new';
        }
        devs[st.mac] = { name: 'Dou', firstSeen: Date.now(), ...dev, mac: st.mac, device: j.device, fw: j.fw, via, online: true, lastSeen: Date.now() };
        st.name = devs[st.mac].name;
        return 'ok';
      });
      if (verdict === 'blocked') { send({ type: 'error', text: 'Thiết bị bị chặn' }); ch.close(); return; }
      if (verdict !== 'ok') {
        send({ type: 'error', text: 'Chờ chủ máy cho phép' });
        if (verdict === 'new') ctx.host.notify({ title: 'Gadget mới muốn kết nối', body: 'Mở AICW Gadgets để cho phép hoặc chặn.' }).catch(() => {});
        ch.close(); return;
      }
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
  if (/timeout|quá lâu/i.test(m)) return 'Agent trả lời quá lâu';
  if (/stt|speech|audio/i.test(m)) return 'Không nghe được';
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
    return { hostId: idn.id, settings: s, bridge: { ...(b || {}), running: !!running }, lanAddresses: ips };
  },

  async agents(_a, ctx) {
    ownerOnly(ctx);
    let ids = [];
    try {
      const out = await ctx.host.tool('agents_list', {});
      const list = out?.details?.agents || out?.details || [];
      ids = (Array.isArray(list) ? list : []).map((a) => (typeof a === 'string' ? a : a.id)).filter(Boolean);
    } catch (e) { ctx.log.warn('agents_list: ' + (e?.message || e)); }
    if (!ids.includes('main')) ids.unshift('main');
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
    await ctx.store.set('restartBridge', Date.now()); // aicw:shared
    return { restarting: true };
  },

  // The bridge itself. Started by the app.ready trigger, the keep-alive timer or the page.
  // Exits at once when another bridge is alive; picks up new settings in place; stops after 5.5 h
  // (the keep-alive timer starts the next one).
  async bridge(_a, ctx) {
    if ((await settings(ctx)).enabled === false) return { disabled: true };
    // Another bridge alive? Its heartbeat is every 10 s: wait 25 s and look again, so a bridge
    // that is just being stopped (or was killed) does not keep the new one from starting.
    const alive = async () => { const b = (await ctx.store.get('bridgeStatus')) || {}; return b.beat && Date.now() - b.beat < 22_000 ? b : null; }; // aicw:shared
    const first = await alive();
    if (first) {
      await new Promise((r) => setTimeout(r, 25_000));
      const again = await alive();
      if (again && again.beat !== first.beat) return { alreadyRunning: true };
    }
    const me = process.pid + ':' + (ctx.job?.id || crypto.randomUUID());
    const idn = await hostIdentity(ctx);
    const startedAt = Date.now();
    const live = new Map();
    const log = (...x) => ctx.log.info(x.join(' '));
    const outer = new AbortController();
    ctx.signal?.addEventListener('abort', () => outer.abort(), { once: true });
    const stop0 = (await ctx.store.get('stopBridge')) || 0; // aicw:shared
    let restartMark = (await ctx.store.get('restartBridge')) || 0; // aicw:shared
    while (!outer.signal.aborted) {
      const s = await settings(ctx);
      const ac = new AbortController();
      outer.signal.addEventListener('abort', () => ac.abort(), { once: true });
      let relay = s.relay ? 'connecting' : 'off', lan = s.lan ? 'starting' : 'off';
      const beat = async () => {
        await ctx.store.set('bridgeStatus', { beat: Date.now(), pid: me, startedAt, hostId: idn.id, relay, lan, lanPort: s.lanPort, online: [...live.keys()] }); // aicw:shared
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
