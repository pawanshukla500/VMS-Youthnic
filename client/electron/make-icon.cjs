// Generates Windows app icons from the repo logo (black mark, transparent bg).
// Output: build/icon.ico (multi-size 256/48/32/16 on a white tile, so the
// black mark stays visible on any light/dark theme) + build/tray.png (64px
// tile for the system tray) + public/favicon-32x32.png and
// public/apple-touch-icon.png (browser tab icons; committed so plain
// `npm run build` / Docker builds ship them without running this script).
// Runs on plain Node (dev + CI) and is part of `npm run dist`, so release
// builds always carry a fresh icon. Re-run if src/assets/logo.png changes.
const fs = require('node:fs');
const path = require('node:path');
const Jimp = require('jimp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'src', 'assets', 'logo.png');
const BUILD = path.join(ROOT, 'build');
const PUBLIC = path.join(ROOT, 'public');
const TILE = 1024;
const PAD_RATIO = 0.08;
const SIZES = [256, 48, 32, 16];

async function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  const mark = await Jimp.read(LOGO);

  // Crop the transparent surround manually (deterministic across versions).
  const { width: w, height: h } = mark.bitmap;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  mark.scan(0, 0, w, h, (x, y, idx) => {
    if (mark.bitmap.data[idx + 3] > 10) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  });
  if (maxX < 0) throw new Error('Logo has no visible pixels');
  mark.crop(minX, minY, maxX - minX + 1, maxY - minY + 1);

  // White tile + centered mark.
  const tile = await new Jimp(TILE, TILE, 0xffffffff);
  const box = Math.floor(TILE * (1 - PAD_RATIO * 2));
  mark.contain(box, box);
  tile.composite(mark, Math.floor((TILE - mark.bitmap.width) / 2), Math.floor((TILE - mark.bitmap.height) / 2));

  const pngPaths = [];
  for (const s of SIZES) {
    const p = path.join(BUILD, `tmp-icon-${s}.png`);
    await tile.clone().resize(s, s).writeAsync(p);
    pngPaths.push(p);
  }
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), await pngToIco(pngPaths));
  await tile.clone().resize(64, 64).writeAsync(path.join(BUILD, 'tray.png'));
  for (const p of pngPaths) fs.unlinkSync(p);
  fs.mkdirSync(PUBLIC, { recursive: true });
  await tile.clone().resize(32, 32).writeAsync(path.join(PUBLIC, 'favicon-32x32.png'));
  await tile.clone().resize(180, 180).writeAsync(path.join(PUBLIC, 'apple-touch-icon.png'));

  // Validate the ICO container we just wrote (reserved=0, type=1, N images).
  const icoPath = path.join(BUILD, 'icon.ico');
  const stat = fs.statSync(icoPath);
  const header = Buffer.alloc(6);
  const fd = fs.openSync(icoPath, 'r');
  fs.readSync(fd, header, 0, 6, 0);
  fs.closeSync(fd);
  const count = header.readUInt16LE(4);
  if (header.readUInt16LE(0) !== 0 || header.readUInt16LE(2) !== 1 || count !== SIZES.length) {
    throw new Error('Generated icon.ico failed validation');
  }
  const trayStat = fs.statSync(path.join(BUILD, 'tray.png'));
  console.log(`icon.ico: ${(stat.size / 1024).toFixed(1)} KB, ${count} sizes (${SIZES.join('/')}); tray.png: ${(trayStat.size / 1024).toFixed(1)} KB; favicons written to public/`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
