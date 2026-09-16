const zlib = require('zlib');

const SAMPLES = [
  {
    value: '8.09',
    data: 'iVBORw0KGgoAAAANSUhEUgAAADIAAAASBAMAAADrvZC0AAAAD1BMVEX///8AAAAAAAAAAAAAAABRO2rwAAAAYElEQVQYlWNgoAlgFBSAsoyB2MUFISMIhGDAbGzAwOLA4gDXIgBCEC3GDEAdLhh6mA2ACEUGZg9YBmgaDj0MLg5wGbg9EBkk01BdwILhAiYFTFdDXKCkhMWnYADSQ28AADz0CoMO2UX6AAAAAElFTkSuQmCC'
  },
  {
    value: '8.53',
    data: 'iVBORw0KGgoAAAANSUhEUgAAADIAAAASBAMAAADrvZC0AAAAD1BMVEX///8AAAAAAAAAAAAAAABRO2rwAAAAYUlEQVQYlWNgoAlgFBQA08zGxsYMLC4uCBlBIATLGAAJFwYWB7gWARCCyYAlMfUYg+QQepDsYTAGSmCxB2ogFnsQjsDiAlQZiGlMCgwMIHtcMFygpARyggGqT8EApIfeAADwnQk6JZ2gQQAAAABJRU5ErkJggg=='
  },
  {
    value: '8.76',
    data: 'iVBORw0KGgoAAAANSUhEUgAAADIAAAASBAMAAADrvZC0AAAAD1BMVEX///8AAAAAAAAAAAAAAABRO2rwAAAAZ0lEQVQYlWNgoAlgFBQA08zGxsYGDC4uCBlBIIQCZgMWBxYHuBYBEILJAHU4YNNjzIBkFsIekBYGFxas9hgzMLhgtQeoBWSaC6YMUAuKDMQ0JgWwFgZkV0NcoKQEkUHxKRgA9dAdAACcvQnAeuv6WQAAAABJRU5ErkJggg=='
  },
  {
    value: '9.24',
    data: 'iVBORw0KGgoAAAANSUhEUgAAADIAAAASBAMAAADrvZC0AAAAD1BMVEX///8AAAAAAAAAAAAAAABRO2rwAAAAbElEQVQYlWNgoAlgFBSAMJiNDYAkiwNcRhAIwcAYCBkYXOAyjAIgBNJiAEIsWGQgki6opsFkjIG2IMkwCsL0gLQgu4ABbhrQAS5AABeH28MMcjSGq5kUwFpQZcA+VVICetQY5FUUexggeugNAHq9CdDGm4SaAAAAAElFTkSuQmCC'
  },
  {
    value: '7.41',
    data: 'iVBORw0KGgoAAAANSUhEUgAAADIAAAASBAMAAADrvZC0AAAAD1BMVEX///8AAAAAAAAAAAAAAABRO2rwAAAAVElEQVQYlWNgoAVgFBQUFICyjRkYWBxQJKEyzEAZF6wyxsYMLKgyglAtBuimwbVg2APXgi6DsN/Y2ABFRhDBRNUD0cKkgEtGSQkiw+KC6myYHvoCACgGCICMkUFfAAAAAElFTkSuQmCC'
  }
];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodeIndexedPng(dataUrl) {
  const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  const png = Buffer.from(base64, 'base64');
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('不是有效的PNG图片');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = [];
  const idat = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      for (let i = 0; i < data.length; i += 3) palette.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
  }

  if (colorType !== 3 || ![1, 2, 4, 8].includes(bitDepth)) {
    throw new Error(`不支持的PNG格式: colorType=${colorType}, bitDepth=${bitDepth}`);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * bitDepth) / 8);
  const rows = [];
  let previous = Buffer.alloc(stride);
  let position = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[position++];
    const current = Buffer.from(inflated.subarray(position, position + stride));
    position += stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x > 0 ? current[x - 1] : 0;
      const up = previous[x] || 0;
      const upperLeft = x > 0 ? previous[x - 1] || 0 : 0;
      if (filter === 1) current[x] = (current[x] + left) & 255;
      if (filter === 2) current[x] = (current[x] + up) & 255;
      if (filter === 3) current[x] = (current[x] + Math.floor((left + up) / 2)) & 255;
      if (filter === 4) current[x] = (current[x] + paeth(left, up, upperLeft)) & 255;
    }

    const pixels = [];
    const mask = (1 << bitDepth) - 1;
    for (let x = 0; x < width; x += 1) {
      const bitOffset = x * bitDepth;
      const byte = current[Math.floor(bitOffset / 8)];
      const shift = 8 - bitDepth - (bitOffset % 8);
      const paletteIndex = (byte >> shift) & mask;
      const rgb = palette[paletteIndex] || [0, 0, 0];
      pixels.push(rgb[0] + rgb[1] + rgb[2] < 690);
    }
    rows.push(pixels);
    previous = current;
  }

  return { width, height, rows };
}

function segmentGlyphs(image) {
  const occupied = Array(image.width).fill(false);
  for (let x = 0; x < image.width; x += 1) {
    occupied[x] = image.rows.some((row) => row[x]);
  }

  const ranges = [];
  for (let x = 0; x < image.width;) {
    while (x < image.width && !occupied[x]) x += 1;
    if (x >= image.width) break;
    const start = x;
    while (x < image.width && occupied[x]) x += 1;
    ranges.push([start, x - 1]);
  }

  return ranges.map(([start, end]) => {
    let top = image.height;
    let bottom = -1;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = start; x <= end; x += 1) {
        if (image.rows[y][x]) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    const rows = image.rows.slice(top, bottom + 1).map((row) => row.slice(start, end + 1));
    return { width: end - start + 1, height: bottom - top + 1, rows };
  });
}

function normalizeGlyph(glyph, targetWidth = 12, targetHeight = 16) {
  const pixels = [];
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(glyph.width - 1, Math.floor((x * glyph.width) / targetWidth));
      const sourceY = Math.min(glyph.height - 1, Math.floor((y * glyph.height) / targetHeight));
      pixels.push(glyph.rows[sourceY][sourceX] ? 1 : 0);
    }
  }
  return pixels;
}

function distance(a, b) {
  let different = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) different += 1;
  return different / a.length;
}

function buildTemplates() {
  const templates = new Map();
  for (const sample of SAMPLES) {
    const glyphs = segmentGlyphs(decodeIndexedPng(sample.data));
    if (glyphs.length !== sample.value.length) throw new Error(`模板切割失败: ${sample.value}`);
    [...sample.value].forEach((character, index) => {
      if (!templates.has(character)) templates.set(character, []);
      templates.get(character).push(normalizeGlyph(glyphs[index]));
    });
  }
  return templates;
}

const templates = buildTemplates();

function decodePriceImage(dataUrl) {
  const glyphs = segmentGlyphs(decodeIndexedPng(dataUrl));
  let value = '';
  let totalDistance = 0;

  for (const glyph of glyphs) {
    if (glyph.height <= 4) {
      value += '.';
      continue;
    }

    const normalized = normalizeGlyph(glyph);
    let bestCharacter = '';
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [character, variants] of templates.entries()) {
      if (character === '.') continue;
      for (const variant of variants) {
        const score = distance(normalized, variant);
        if (score < bestDistance) {
          bestDistance = score;
          bestCharacter = character;
        }
      }
    }

    if (!bestCharacter || bestDistance > 0.36) throw new Error('价格图片字体无法识别');
    value += bestCharacter;
    totalDistance += bestDistance;
  }

  if (!/^\d{1,3}\.\d{2}$/.test(value)) throw new Error(`价格图片格式异常: ${value}`);
  return { value: Number(value), text: value, confidence: Math.max(0, 1 - totalDistance / Math.max(1, glyphs.length - 1)) };
}

function selfTest() {
  return SAMPLES.map((sample) => ({ expected: sample.value, actual: decodePriceImage(sample.data).text }));
}

module.exports = { decodePriceImage, selfTest };
