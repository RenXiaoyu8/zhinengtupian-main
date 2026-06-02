import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const sourceSvg = path.join(rootDir, '尚品易站云资产logo-01.svg');
const pngOutput = path.join(rootDir, 'build', 'app-icon.png');
const icoOutput = path.join(rootDir, 'build', 'app-icon.ico');

const sizes = [16, 24, 32, 48, 64, 128, 256];

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createIco(buffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(buffers.length, 4);

  let offset = 6 + buffers.length * 16;
  const entries = [];
  for (let i = 0; i < buffers.length; i += 1) {
    const { size, buffer } = buffers[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buffer.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...buffers.map(item => item.buffer)]);
}

async function main() {
  if (!fs.existsSync(sourceSvg)) {
    throw new Error(`missing icon source: ${sourceSvg}`);
  }

  ensureDir(pngOutput);
  ensureDir(icoOutput);

  await sharp(sourceSvg, { density: 300, limitInputPixels: false })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(pngOutput);

  const icoBuffers = [];
  for (const size of sizes) {
    const buffer = await sharp(sourceSvg, { density: 300, limitInputPixels: false })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    icoBuffers.push({ size, buffer });
  }

  fs.writeFileSync(icoOutput, createIco(icoBuffers));
  console.log(`generated ${path.relative(rootDir, pngOutput)} and ${path.relative(rootDir, icoOutput)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
