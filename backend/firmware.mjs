// Firmware catalog and download: GitHub Releases of Neurons-AI/aicoworker-gadgets.
// Each release carries one asset per board: aicw-gadgets-<board>-<version>.bin (a merged image
// that starts at offset 0x0, made by `esptool merge-bin`) and manifest.json listing them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'assets', 'boards.json'), 'utf8'));

export function boardsForUsb(usb) {
  if (!usb) return [];
  return CATALOG.boards.filter((b) => (b.usb || []).includes(usb));
}

/** Newest release that has a manifest.json; cached for 10 minutes. */
export async function latestRelease(ctx) {
  const cached = await ctx.store.get('releaseCache'); // aicw:shared
  if (cached && Date.now() - cached.at < 600_000) return cached.release;
  const r = await fetch(`https://api.github.com/repos/${CATALOG.repo}/releases?per_page=5`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'aicw-gadgets' } });
  if (!r.ok) throw new Error(`GitHub releases: HTTP ${r.status}`);
  const list = await r.json();
  for (const rel of list) {
    if (rel.draft) continue;
    const m = rel.assets.find((a) => a.name === 'manifest.json');
    if (!m) continue;
    const manifest = await (await fetch(m.browser_download_url, { headers: { 'user-agent': 'aicw-gadgets' } })).json();
    const release = { tag: rel.tag_name, name: rel.name, publishedAt: rel.published_at, prerelease: rel.prerelease, manifest, assets: Object.fromEntries(rel.assets.map((a) => [a.name, a.browser_download_url])) };
    await ctx.store.set('releaseCache', { at: Date.now(), release }); // aicw:shared
    return release;
  }
  await ctx.store.set('releaseCache', { at: Date.now(), release: null }); // aicw:shared
  return null;
}

/** Images to flash for a board: [{ offset, data }] from the release, or from a local build dir (developer). */
export async function imagesFor(ctx, boardId, { localBuild } = {}) {
  if (localBuild) {
    const args = JSON.parse(fs.readFileSync(path.join(localBuild, 'flasher_args.json'), 'utf8'));
    return {
      version: 'local build',
      images: Object.entries(args.flash_files).map(([off, f]) => ({ offset: parseInt(off, 16), data: fs.readFileSync(path.join(localBuild, f)) })),
    };
  }
  const rel = await latestRelease(ctx);
  if (!rel) throw new Error('Chưa có bản firmware nào được phát hành');
  const entry = rel.manifest.boards?.[boardId];
  if (!entry) throw new Error(`Bản ${rel.tag} chưa có firmware cho bo mạch này`);
  const dir = path.join(ctx.dataDir, 'firmware', rel.tag); // aicw:shared — a download cache for every user
  fs.mkdirSync(dir, { recursive: true }); // aicw:shared
  const file = path.join(dir, entry.file);
  if (!fs.existsSync(file)) {
    const url = rel.assets[entry.file];
    if (!url) throw new Error(`Thiếu tệp ${entry.file} trong bản ${rel.tag}`);
    const res = await fetch(url, { headers: { 'user-agent': 'aicw-gadgets' } });
    if (!res.ok) throw new Error(`Tải firmware lỗi: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (entry.size && buf.length !== entry.size) throw new Error('Tệp firmware tải về bị thiếu, thử lại');
    if (entry.sha256) {
      const h = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
      if (h !== entry.sha256) throw new Error('Tệp firmware không khớp mã kiểm tra');
    }
    fs.writeFileSync(file + '.part', buf); // aicw:shared — firmware download cache
    fs.renameSync(file + '.part', file); // aicw:shared
  }
  return { version: rel.tag, images: [{ offset: entry.offset ?? 0, data: fs.readFileSync(file) }] };
}
