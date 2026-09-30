import sharp from "sharp";

/**
 * Deterministic test photos: 1200 × 900 JPEGs of 8-pixel grey blocks from a seeded generator. They pass the real
 * checks (short side ≥ 800 px, sharp edges well above the blur threshold, mid brightness) and each seed gives a
 * different perceptual hash, so photos from different journeys never count as duplicates of each other.
 */
export async function testPhoto(seed: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  let x = [...seed].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const next = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const width = 1200;
  const height = 900;
  const block = 8;
  const raw = Buffer.alloc(width * height);
  const cols = width / block;
  const cells = Array.from({ length: cols * Math.ceil(height / block) }, () => 60 + Math.floor(next() * 136)); // 60–195
  for (let y = 0; y < height; y++) for (let px = 0; px < width; px++) raw[y * width + px] = cells[Math.floor(y / block) * cols + Math.floor(px / block)]!;
  const buffer = await sharp(raw, { raw: { width, height, channels: 1 } }).jpeg({ quality: 85 }).toBuffer();
  return { name: `${seed.replace(/[^a-z0-9-]/gi, "-")}.jpg`, mimeType: "image/jpeg", buffer };
}
