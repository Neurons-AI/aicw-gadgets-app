// USB serial for the backend: list ports, talk to the gadget console, and flash with esptool-js.
// esptool-js expects a Web Serial port; WebSerialShim wraps node-serialport to look like one.
import { SerialPort } from 'serialport';

export async function listPorts() {
  const ports = await SerialPort.list();
  return ports
    .filter((p) => p.vendorId || /usb|acm|modem|serial/i.test(p.path))
    .map((p) => ({
      path: p.path,
      usb: p.vendorId ? `${p.vendorId.toLowerCase()}:${(p.productId || '').toLowerCase()}` : null,
      maker: p.manufacturer || null,
      serial: p.serialNumber || null,
    }));
}

/** Minimal Web Serial SerialPort over node-serialport (what esptool-js's Transport uses). */
export class WebSerialShim {
  constructor(path, usb) {
    this.path = path; this.port = null; this.readable = null; this.writable = null;
    const [v, p] = String(usb || '').split(':');
    this.info = v ? { usbVendorId: parseInt(v, 16), usbProductId: parseInt(p, 16) } : {};
    this.sig = { dtr: false, rts: false };
  }
  getInfo() { return this.info; }
  async open({ baudRate }) {
    await this.close();
    this.port = new SerialPort({ path: this.path, baudRate, autoOpen: false, hupcl: false });
    await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    const port = this.port;
    this.readable = new ReadableStream({
      start(ctrl) {
        port.on('data', (d) => { try { ctrl.enqueue(new Uint8Array(d)); } catch {} });
        port.on('close', () => { try { ctrl.close(); } catch {} });
        port.on('error', (e) => { try { ctrl.error(e); } catch {} });
      },
    });
    this.writable = new WritableStream({
      write(chunk) { return new Promise((res, rej) => port.write(Buffer.from(chunk), (e) => (e ? rej(e) : port.drain(() => res())))); },
    });
  }
  async setSignals({ dataTerminalReady, requestToSend, break: brk }) {
    // node-serialport resets lines it is not given, so always send both
    if (dataTerminalReady !== undefined) this.sig.dtr = !!dataTerminalReady;
    if (requestToSend !== undefined) this.sig.rts = !!requestToSend;
    const s = { dtr: this.sig.dtr, rts: this.sig.rts };
    if (brk !== undefined) s.brk = !!brk;
    await new Promise((res) => this.port.set(s, () => res()));
  }
  async close() {
    if (this.port?.isOpen) await new Promise((res) => this.port.close(() => res()));
    this.port = null;
  }
}

// Chips on their own USB-JTAG port (S3, C3, C6, C5…) come back from an RTS reset in download
// mode. Do what esptool.py does: clear "force download boot" and reset through the RTC watchdog.
const WDT = {
  'ESP32-S3': { base: 0x60008000, wdt0: 0x98, wdt1: 0x9c, wprot: 0xb0, opt1: 0x6000812c },
  'ESP32-C3': { base: 0x60008000, wdt0: 0x90, wdt1: 0x94, wprot: 0xa8, opt1: 0x60008128 },
};
const WDT_KEY = 0x50d83aa1;
async function rebootIntoApp(loader) {
  const name = String(loader.chip?.CHIP_NAME || '');
  const r = WDT[name];
  if (!r || !(await loader.isUsbJtagSerialPort?.())) return loader.after('hard_reset');
  try { await loader.writeReg(r.opt1, 0, 0x1); } catch {}
  await loader.writeReg(r.base + r.wprot, WDT_KEY);
  await loader.writeReg(r.base + r.wdt1, 2000);
  await loader.writeReg(r.base + r.wdt0, ((1 << 31) | (5 << 28) | (1 << 8) | 2) >>> 0);
  await loader.writeReg(r.base + r.wprot, 0);
  await new Promise((res) => setTimeout(res, 500));
}

/** Reboot a gadget that sits in download mode (after a flash, or a USB reset) into its firmware. */
export async function rebootGadget(path, usb) {
  const { ESPLoader, Transport } = await import('esptool-js');
  if (!usb) usb = (await listPorts()).find((p) => p.path === path)?.usb;
  const device = new WebSerialShim(path, usb);
  const transport = new Transport(device, false);
  const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: { clean() {}, writeLine() {}, write() {} } });
  try { await loader.main(); await rebootIntoApp(loader); return { ok: true }; }
  finally { await transport.disconnect().catch(() => {}); await device.close().catch(() => {}); }
}

/** Send console lines (each prefixed with '>') and collect lines that start with '@'. */
export async function consoleCommand(path, lines, { waitFor = [], timeoutMs = 8000 } = {}) {
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false, hupcl: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  let buf = '';
  const answers = [];
  port.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line.startsWith('@')) answers.push(line);
    }
  });
  try {
    for (const l of lines) {
      await new Promise((res) => port.write('\n>' + l + '\n', () => port.drain(res)));
      await new Promise((r) => setTimeout(r, 300));
    }
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (waitFor.length && waitFor.every((w) => answers.some((a) => a.startsWith(w)))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await new Promise((res) => port.close(() => res()));
  }
  return answers;
}

/** Read every line for `ms` (boot log). */
export async function readLog(path, ms = 6000) {
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false, hupcl: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  let out = '';
  port.on('data', (d) => { out += d.toString('utf8'); });
  await new Promise((r) => setTimeout(r, ms));
  await new Promise((res) => port.close(() => res()));
  return out;
}

/**
 * Flash images [{ offset, data: Buffer }] with esptool-js, then hard-reset.
 * onProgress(fraction, text). Returns { chip, mac, flashSize }.
 */
export async function flash(path, images, { onProgress = () => {}, eraseAll = false, baud = 460800, usb } = {}) {
  const { ESPLoader, Transport } = await import('esptool-js');
  if (!usb) usb = (await listPorts()).find((p) => p.path === path)?.usb;
  const device = new WebSerialShim(path, usb);
  const transport = new Transport(device, false);
  const terminal = { clean() {}, writeLine(l) { onProgress(null, String(l)); }, write(l) { onProgress(null, String(l)); } };
  const loader = new ESPLoader({ transport, baudrate: baud, romBaudrate: 115200, terminal, debugLogging: false });
  try {
    const chip = await loader.main();
    const mac = await loader.chip.readMac(loader).catch(() => null);
    const total = images.reduce((n, i) => n + i.data.length, 0);
    let before = 0;
    await loader.writeFlash({
      fileArray: images.map((i) => ({ data: new Uint8Array(i.data), address: i.offset })),
      flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep', eraseAll, compress: true,
      reportProgress: (fileIndex, written, size) => {
        const done = images.slice(0, fileIndex).reduce((n, i) => n + i.data.length, 0) + (written / size) * images[fileIndex].data.length;
        if (done - before > total / 200 || written === size) { before = done; onProgress(done / total, `writing ${Math.round((100 * done) / total)}%`); }
      },
    });
    await rebootIntoApp(loader).catch(() => loader.after('hard_reset').catch(() => {}));
    return { chip, mac };
  } finally {
    await transport.disconnect().catch(() => {});
    await device.close().catch(() => {});
  }
}
