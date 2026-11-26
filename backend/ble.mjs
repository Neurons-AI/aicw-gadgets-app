// BLE side of gadget setup, run from the app backend with noble (macOS, Windows,
// Linux; prebuilt binaries). scan() finds gadgets waiting for setup; setup()
// pairs (the person presses the gadget's button) and sends Wi-Fi + AICW host.
import { PairingClient, Reassembler, frame, SERVICE_UUID, RX_UUID, TX_UUID, STATUS_TEXT } from './pairing.mjs';

let noblePromise = null;
async function getNoble() {
  if (!noblePromise) {
    noblePromise = (async () => {
      const mod = await import('@stoprocent/noble');
      const noble = mod.withBindings ? mod.withBindings('default') : (mod.default || mod);
      if (noble.state !== 'poweredOn') {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`Bluetooth not ready (${noble.state}). Turn Bluetooth on and allow AICoworker to use it.`)), 8000);
          noble.on('stateChange', (s) => { if (s === 'poweredOn') { clearTimeout(t); resolve(); } });
        });
      }
      return noble;
    })().catch((e) => { noblePromise = null; throw e; });
  }
  return noblePromise;
}

const found = new Map(); // id -> peripheral

export async function scan(ms = 6000) {
  const noble = await getNoble();
  const out = new Map();
  const onDiscover = (p) => {
    const uuids = (p.advertisement?.serviceUuids || []).map((u) => u.replace(/-/g, '').toLowerCase());
    if (!uuids.includes(SERVICE_UUID)) return;
    found.set(p.id, p);
    const mfg = p.advertisement?.manufacturerData;
    out.set(p.id, { id: p.id, name: p.advertisement?.localName || 'Dou gadget', rssi: p.rssi, mfg: mfg ? mfg.toString('hex') : '' });
  };
  noble.on('discover', onDiscover);
  try {
    await noble.startScanningAsync([SERVICE_UUID], true);
    await new Promise((r) => setTimeout(r, ms));
  } finally {
    await noble.stopScanningAsync().catch(() => {});
    noble.removeListener('discover', onDiscover);
  }
  return [...out.values()].sort((a, b) => b.rssi - a.rssi);
}

// Pair with one gadget and give it Wi-Fi + the AICW host. onStep({ step, text })
// reports progress in plain words. When the gadget cannot join the Wi-Fi (wrong
// password, wrong name), retry({ reason, networks, ssidSeen }) is awaited for new
// { ssid, password } on the SAME session (no second button press); return null to stop.
// Resolves with { device, networks } when the gadget says auth_ok.
export async function setup(id, { ssid, password, host }, onStep = () => {}, retry = async () => null) {
  if (!host) throw new Error('Host is required');
  const noble = await getNoble();
  let p = found.get(id);
  if (!p) { await scan(5000); p = found.get(id); }
  if (!p) throw new Error('Gadget not found over Bluetooth. Is it close by and not set up yet?');

  const step = (s, extra) => onStep({ step: s, text: STATUS_TEXT[s] || s, ...extra });
  step('connecting', { text: 'Đang kết nối Bluetooth…' });
  // A link left over from an earlier attempt (cancelled, page closed) blocks a new one.
  if (p.state === 'connected' || p.state === 'connecting') { await p.disconnectAsync().catch(() => {}); await new Promise((r) => setTimeout(r, 600)); }
  try { await p.connectAsync(); }
  catch (e) {
    if (!/already connected/i.test(String(e?.message))) throw e;
    await p.disconnectAsync().catch(() => {}); await new Promise((r) => setTimeout(r, 800));
    await p.connectAsync();
  }
  const done = { closed: false };
  p.once('disconnect', () => { done.closed = true; });
  try {
    const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [RX_UUID, TX_UUID]);
    const rx = characteristics.find((c) => c.uuid.replace(/-/g, '') === RX_UUID);
    const tx = characteristics.find((c) => c.uuid.replace(/-/g, '') === TX_UUID);
    if (!rx || !tx) throw new Error('This gadget has no AICW setup service');
    const mtu = p.mtu || 185;

    const ra = new Reassembler();
    const inbox = [];
    let wake = null;
    tx.on('data', (buf) => { for (const m of ra.push(buf)) { try { inbox.push(JSON.parse(m)); } catch {} } wake?.(); });
    await tx.subscribeAsync();
    const send = async (obj) => { for (const f of frame(JSON.stringify(obj), mtu)) await rx.writeAsync(f, false); };
    const next = async (ms) => {
      const until = Date.now() + ms;
      while (!inbox.length) {
        if (done.closed) throw new Error('Gadget dropped the Bluetooth link');
        const left = until - Date.now();
        if (left <= 0) throw new Error('Gadget did not answer in time');
        await new Promise((r) => { wake = r; setTimeout(r, Math.min(left, 500)); });
        wake = null;
      }
      return inbox.shift();
    };

    const client = new PairingClient();
    await send(client.hello('confirm_press', 'none'));
    let msg = await next(15000);
    if (msg.type === 'status') throw new Error(STATUS_TEXT[msg.status] || msg.status);
    const device = client.ready(msg);
    step('pairing_confirm_required', { device });
    await send(client.seal({ action: 'pairing_client_finished' }));

    let networks = [];
    let phase = 'confirm'; // confirm -> scan -> provision
    let cur = { ssid, password: password || '' };
    const provision = async () => {
      if (!cur.ssid) {
        const r = await retry({ reason: 'need_ssid', networks, ssidSeen: false });
        if (!r) throw new Error('Cancelled');
        cur = { ssid: r.ssid, password: r.password || '' };
      }
      phase = 'provision';
      await send(client.seal({ action: 'provision_v2', ssid: cur.ssid, password: cur.password, aicw_host: host }));
    };
    let deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const m = client.open(await next(Math.max(1000, deadline - Date.now())));
      if (m.type === 'wifi_scan_result') {
        networks = (m.networks || []).filter((n) => n.ssid).map((n) => ({ ssid: n.ssid, rssi: n.rssi, secure: n.secure !== false }));
        step('wifi_scan', { text: `Gadget thấy ${networks.length} mạng Wi-Fi`, networks });
        if (phase === 'scan') await provision();
        continue;
      }
      if (m.type !== 'status') continue;
      step(m.status);
      if (m.status === 'pairing_confirmed' && phase === 'confirm') {
        phase = 'scan';
        await send(client.seal({ action: 'wifi_scan' }));
      } else if (m.status === 'auth_ok') {
        return { device, networks, ssid: cur.ssid };
      } else if (m.status === 'wifi_failed') {
        // Same session stays in provisioning: ask for the Wi-Fi again.
        const ssidSeen = networks.some((n) => n.ssid === cur.ssid);
        const r = await retry({ reason: ssidSeen ? 'wrong_password' : 'ssid_not_seen', ssid: cur.ssid, networks, ssidSeen });
        if (!r) throw new Error(STATUS_TEXT.wifi_failed);
        cur = { ssid: r.ssid || cur.ssid, password: r.password || '' };
        deadline = Date.now() + 150000;
        await provision();
      } else if (/^error_|_failed$/.test(m.status)) {
        throw new Error(STATUS_TEXT[m.status] || m.status);
      }
    }
    throw new Error('Setup timed out');
  } finally {
    await p.disconnectAsync().catch(() => {});
  }
}
