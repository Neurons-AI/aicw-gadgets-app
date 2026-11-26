// Client ("mobile") side of the gadget's BLE setup: pairing protocol v5
// (P-256 ECDH + HKDF-SHA256 + AES-256-GCM, community auth), then provision_v2
// with Wi-Fi and the AICW host. Transport-agnostic: give it send(bytes) and feed
// it the notifications. Mirrors esp32/main/link_pairing.c + ble_server.c.
import crypto from 'node:crypto';

export const SERVICE_UUID = '7fdd3d1c38ea46cf8b46314ecf5f240c';
export const RX_UUID = '4d59302928a24a6ea1f03c2d5e8f9b01'; // write: app -> gadget
export const TX_UUID = 'd75dc4ca7b2b4e9c8f0a1d2e3f4a5b6c'; // notify: gadget -> app
export const NAME_PREFIX = 'DouGadget';

const VERSION = 5;
const MODEL = 'hatch_link';
const SUITE = 'p256-hkdf-sha256-aes-gcm-v1';
const LABEL = 'hatch-link ble setup v1';
const SID_LABEL = 'hatch-link session id v1';
const CHUNK_MAGIC = 0xfe;

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const hkdfExtract = (salt, ikm) => crypto.createHmac('sha256', salt).update(ikm).digest();
const hkdfExpand32 = (prk, info) => crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();

export function transcript(f) {
  const button = f.pairing_policy === 'confirm_press';
  return [
    `hatch-link-pairing-v${VERSION}`, `version=${VERSION}`, 'initiator_role=mobile', 'responder_role=link',
    `device_id=${f.device_id}`, `node_id=${f.node_id}`, `mac=${f.mac}`, `model=${MODEL}`,
    `firmware_version=${f.firmware_version}`, `selected_cipher_suite=${SUITE}`,
    `pairing_auth=${f.pairing_auth}`, `pairing_auth_epoch=${f.pairing_auth_epoch}`,
    `pairing_policy=${f.pairing_policy}`, `confirm_timeout_seconds=${button ? 60 : 0}`,
    `mobile_pub=${f.mobile_pub}`, `device_pub=${f.device_pub}`,
    `mobile_nonce=${f.mobile_nonce}`, `device_nonce=${f.device_nonce}`,
  ].join('\n');
}

// Split one JSON message into notification/write frames [0xFE, idx, total, ...].
export function frame(text, mtu = 185) {
  const data = Buffer.from(text, 'utf8');
  const usable = Math.max(20, Math.min(mtu - 3, 512) - 3);
  const total = Math.max(1, Math.ceil(data.length / usable));
  if (total > 255) throw new Error('message too long for BLE framing');
  const out = [];
  for (let i = 0; i < total; i++) out.push(Buffer.concat([Buffer.from([CHUNK_MAGIC, i, total]), data.subarray(i * usable, (i + 1) * usable)]));
  return out;
}

// Reassemble frames from the gadget; returns full messages (strings).
export class Reassembler {
  constructor() { this.parts = []; this.total = 0; }
  push(buf) {
    buf = Buffer.from(buf);
    if (buf.length < 3 || buf[0] !== CHUNK_MAGIC) return [buf.toString('utf8')];
    const [, idx, total] = buf;
    if (idx === 0 || total !== this.total) { this.parts = []; this.total = total; }
    if (idx !== this.parts.length) { this.parts = []; this.total = 0; return []; }
    this.parts.push(buf.subarray(3));
    if (this.parts.length < this.total) return [];
    const msg = Buffer.concat(this.parts).toString('utf8');
    this.parts = []; this.total = 0;
    return [msg];
  }
}

export class PairingClient {
  constructor() {
    this.ecdh = crypto.createECDH('prime256v1');
    this.ecdh.generateKeys();
    this.nonce = crypto.randomBytes(16);
    this.txCounter = 0n; this.rxCounter = 0n;
  }
  hello(policy = 'confirm_press', auth = 'none') {
    return { action: 'pairing_client_hello', version: VERSION, pairing_auth: auth, pairing_policy: policy, mobile_pub: b64u(this.ecdh.getPublicKey()), mobile_nonce: b64u(this.nonce) };
  }
  // Check pairing_ready and derive the session keys. Throws on any mismatch.
  ready(r) {
    if (r.type !== 'pairing_ready' || r.version !== VERSION || r.model !== MODEL) throw new Error('unexpected pairing_ready');
    if (r.pairing_auth !== 'none') throw new Error('gadget uses manufacturer pairing (not community)');
    const t = transcript({ ...r, mobile_pub: b64u(this.ecdh.getPublicKey()), mobile_nonce: b64u(this.nonce) });
    const th = sha256(t);
    if (b64u(th) !== r.transcript_hash) throw new Error('transcript hash mismatch');
    const devicePub = unb64u(r.device_pub);
    const deviceNonce = unb64u(r.device_nonce);
    const ecdh = this.ecdh.computeSecret(devicePub);
    const salt = sha256(this.nonce, deviceNonce, th);
    const secret = hkdfExpand32(hkdfExtract(salt, ecdh), LABEL);
    this.txKey = hkdfExpand32(secret, 'mobile->device');
    this.rxKey = hkdfExpand32(secret, 'device->mobile');
    const sid = sha256(Buffer.from(SID_LABEL), th, ecdh).subarray(0, 16);
    this.sessionId = b64u(sid);
    if (this.sessionId !== r.session_id) throw new Error('session id mismatch');
    this.device = { device_id: r.device_id, node_id: r.node_id, mac: r.mac, firmware_version: r.firmware_version, policy: r.pairing_policy };
    return this.device;
  }
  nonceFor(dir, counter) { const n = Buffer.alloc(12); n[0] = dir; n.writeBigUInt64BE(counter, 4); return n; }
  aad(dir, counter) { return Buffer.from(`${LABEL}|${this.sessionId}|${dir === 0 ? 'm2d' : 'd2m'}|${counter}`); }
  seal(obj) {
    const c = this.txCounter++;
    const g = crypto.createCipheriv('aes-256-gcm', this.txKey, this.nonceFor(0, c));
    g.setAAD(this.aad(0, c));
    const ct = Buffer.concat([g.update(JSON.stringify(obj), 'utf8'), g.final()]);
    return { action: 'pairing_encrypted', session_id: this.sessionId, counter: String(c), ciphertext: b64u(ct), tag: b64u(g.getAuthTag()) };
  }
  open(env) {
    if (env.type !== 'pairing_encrypted') return env; // plaintext status (errors only)
    if (env.session_id !== this.sessionId) throw new Error('wrong session');
    const c = BigInt(env.counter);
    if (c !== this.rxCounter) throw new Error('unexpected counter');
    const d = crypto.createDecipheriv('aes-256-gcm', this.rxKey, this.nonceFor(1, c));
    d.setAAD(this.aad(1, c));
    d.setAuthTag(unb64u(env.tag));
    const pt = Buffer.concat([d.update(unb64u(env.ciphertext)), d.final()]).toString('utf8');
    this.rxCounter++;
    return JSON.parse(pt);
  }
}

// Plain words for the statuses a gadget sends during setup.
export const STATUS_TEXT = {
  pairing_confirm_required: 'Bấm nút trên gadget để xác nhận',
  pairing_confirmed: 'Đã ghép đôi',
  wifi_connecting: 'Gadget đang vào Wi-Fi…',
  wifi_connected: 'Gadget đã vào Wi-Fi',
  wifi_failed: 'Không vào được Wi-Fi (sai mật khẩu hoặc sóng yếu)',
  auth_ok: 'Xong: gadget đã lưu máy chủ và đang khởi động lại',
  error_pairing_unavailable: 'Gadget đã được cài rồi: giữ nút để đặt lại rồi thử lại',
  error_pairing_invalid_hello: 'Gadget không nhận yêu cầu ghép đôi (firmware cũ?)',
  error_pairing_decrypt: 'Mất phiên mã hoá, thử lại',
  error_pairing_confirm_required: 'Chưa bấm nút xác nhận trên gadget',
  error_pairing_confirm_timeout: 'Hết giờ bấm nút xác nhận',
  error_missing_credentials: 'Firmware này chưa nhận cài đặt AICW qua Bluetooth: nạp bản mới qua USB',
  error_storage: 'Gadget không lưu được cài đặt',
  error_operation_in_progress: 'Gadget đang bận, thử lại sau ít giây',
};
