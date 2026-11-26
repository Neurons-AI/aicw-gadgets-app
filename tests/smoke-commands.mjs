// Calls every non-hardware backend command with an in-memory ctx: catches a command that
// throws ReferenceError/TypeError (missing helper, typo) before it reaches anyone.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const mod = await import(new URL('../backend/main.mjs', import.meta.url));
const cmds = mod.default || mod.commands || mod;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gadgets-smoke-'));
const store = new Map();
const ctx = {
  dataDir: dir, userDataDir: dir, user: { role: 'owner' },
  store: { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) },
  events: { emit: () => {} }, log: { info() {}, warn() {}, error() {} },
  host: { tool: async () => ({ details: { agents: [{ id: 'main', name: 'Ani' }], messages: [] } }), notify: async () => {} },
  triggers: { arm: async () => {} },
};
const calls = [
  ['status', {}], ['listDevices', {}], ['agents', {}], ['connectCode', {}], ['setupLinks', {}],
  ['setTarget', {}], ['updateSettings', { open: true }], ['updateDevice', { mac: 'aabbccddeeff', name: 'X' }],
  ['removeDevice', { mac: 'aabbccddeeff' }], ['removeSetupLink', { id: 'nope' }], ['channelHistory', { mac: 'aabbccddeeff' }],
  ['rotateCode', {}], ['startBridge', {}], ['stopBridge', {}], ['restartBridge', {}],
];
let bad = 0;
for (const [n, a] of calls) {
  if (typeof cmds[n] !== 'function') { console.log('MISSING command', n); bad++; continue; }
  try { await cmds[n](a, ctx); console.log('ok  ', n); }
  catch (e) {
    const fatal = /ReferenceError|TypeError|is not defined|is not a function/.test(String(e?.stack || e));
    console.log(fatal ? 'FAIL' : 'ok* ', n, fatal ? String(e).slice(0, 120) : '(' + String(e.message).slice(0, 60) + ')');
    if (fatal) bad++;
  }
}
const c1 = (await cmds.connectCode({}, ctx)).code;
const c2 = (await cmds.connectCode({}, ctx)).code;
if (c1 !== c2) { console.log('FAIL code changed between reads'); bad++; } else console.log('ok   code stable');
console.log(bad ? `FAILED ${bad}` : 'ALL OK');
process.exit(bad ? 1 : 0);
