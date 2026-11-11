import sharp from 'sharp';
import { compositeProduct, extractProduct, fitCover, fontFamily, placeLogo, renderOverlay, resizeExact, toJpeg } from './compose';

/** A product photo: white studio backdrop with a red disc and a blue label. */
async function studioPhoto(size = 800) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#ffffff"/><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.3}" fill="#d01010"/><rect x="${size * 0.4}" y="${size * 0.45}" width="${size * 0.2}" height="${size * 0.1}" fill="#1020c0"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const px = async (img: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * 3;
  return [data[o]!, data[o + 1]!, data[o + 2]!];
};
const sceneBg = (w = 1000, h = 1000, color = '#88aa66') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

describe('extractProduct', () => {
  it('cuts a product out of a plain studio background', async () => {
    const cut = await extractProduct(await studioPhoto());
    expect(cut).not.toBeNull();
    expect(cut!.method).toBe('uniform-background');
    // The disc has radius 0.3 of the frame: the trimmed cutout is about 0.6 wide.
    expect(cut!.width).toBeGreaterThan(800 * 0.55);
    expect(cut!.width).toBeLessThan(800 * 0.68);
    expect(cut!.coverage).toBeGreaterThan(0.2);
    // Corners of the cutout are transparent; the centre is opaque.
    const { data, info } = await sharp(cut!.png).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(data[(Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4 + 3]).toBe(255);
  });

  it('uses the alpha channel when the photo is already transparent', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect x="150" y="150" width="300" height="300" fill="#10a010"/></svg>`;
    const cut = await extractProduct(await sharp(Buffer.from(svg)).png().toBuffer());
    expect(cut).toMatchObject({ method: 'alpha' });
    expect(cut!.width).toBeGreaterThanOrEqual(300);
    expect(cut!.width).toBeLessThan(310);
  });

  it('refuses a busy background instead of guessing', async () => {
    const noise = await sharp({ create: { width: 400, height: 400, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 }, background: '#808080' } }).png().toBuffer();
    expect(await extractProduct(noise)).toBeNull();
  });

  it('refuses a photo where the product fills the frame, or nothing is there', async () => {
    expect(await extractProduct(await sceneBg(400, 400, '#ffffff'))).toBeNull(); // nothing but background
    const full = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#ffffff"/><rect x="4" y="4" width="392" height="392" fill="#aa2222"/></svg>`;
    expect(await extractProduct(await sharp(Buffer.from(full)).png().toBuffer())).toBeNull();
  });
});

describe('compositeProduct: the real product pixels are kept', () => {
  it("places the product's own pixels, unchanged, on the generated scene (scale 1)", async () => {
    const cut = (await extractProduct(await studioPhoto()))!;
    const { image, placement } = await compositeProduct({ background: await sceneBg(1000, 1000), cutout: cut, width: 1000, height: 1000, fixedScale: 1, shadow: false });
    expect(placement).toMatchObject({ width: cut.width, height: cut.height, scale: 1 });
    // The product centre is the original red; the blue label is the original blue; the scene shows around them.
    const cx = placement.left + Math.floor(cut.width / 2);
    const cy = placement.top + Math.floor(cut.height / 2);
    expect(await px(image, cx, cy - Math.floor(cut.height * 0.25))).toEqual([0xd0, 0x10, 0x10]);
    expect(await px(image, cx, cy)).toEqual([0x10, 0x20, 0xc0]);
    expect(await px(image, 5, 5)).toEqual([0x88, 0xaa, 0x66]);
    // Pixel-for-pixel: a window inside the product equals the source cutout's pixels.
    const src = await sharp(cut.png).extract({ left: Math.floor(cut.width / 2) - 10, top: Math.floor(cut.height * 0.2), width: 20, height: 20 }).removeAlpha().raw().toBuffer();
    const out = await sharp(image).extract({ left: cx - 10, top: placement.top + Math.floor(cut.height * 0.2), width: 20, height: 20 }).removeAlpha().raw().toBuffer();
    expect(out.equals(src)).toBe(true);
  });

  it('fits the product into the frame and keeps it clear of the text area', async () => {
    const cut = (await extractProduct(await studioPhoto()))!;
    for (const avoid of ['TOP', 'BOTTOM'] as const) {
      const { placement } = await compositeProduct({ background: await sceneBg(1080, 1350), cutout: cut, width: 1080, height: 1350, avoid });
      expect(placement.left).toBeGreaterThanOrEqual(0);
      expect(placement.left + placement.width).toBeLessThanOrEqual(1080);
      if (avoid === 'TOP') expect(placement.top).toBeGreaterThan(1350 * 0.2);
      else expect(placement.top + placement.height).toBeLessThan(1350 * 0.8);
    }
  });

  it('draws a soft shadow under the product', async () => {
    const cut = (await extractProduct(await studioPhoto()))!;
    const { image, placement } = await compositeProduct({ background: await sceneBg(1000, 1000, '#ffffff'), cutout: cut, width: 1000, height: 1000, fixedScale: 1 });
    const below = await px(image, placement.left + Math.floor(cut.width / 2), placement.top + cut.height + 4);
    expect(below[0]).toBeLessThan(250); // darker than the white scene
  });
});

describe('text overlay and logo', () => {
  const grey = () => sceneBg(1080, 1080, '#808080');
  const rowsDiffer = async (a: Buffer, b: Buffer, from: number, to: number) => {
    const w = 1080;
    const [ra, rb] = await Promise.all([a, b].map((x) => sharp(x).removeAlpha().extract({ left: 0, top: from, width: w, height: to - from }).raw().toBuffer()));
    let n = 0;
    for (let i = 0; i < ra!.length; i += 3) if (ra![i] !== rb![i]) n++;
    return n;
  };

  it('draws the text where requested', async () => {
    const base = await grey();
    const top = await renderOverlay(base, { text: 'Fresh bissap juice', position: 'TOP', width: 1080, height: 1080, fontFamily: fontFamily('Inter') });
    const bottom = await renderOverlay(base, { text: 'Fresh bissap juice', position: 'BOTTOM', width: 1080, height: 1080 });
    expect(await rowsDiffer(base, top, 0, 300)).toBeGreaterThan(5000);
    expect(await rowsDiffer(base, top, 700, 1080)).toBe(0);
    expect(await rowsDiffer(base, bottom, 700, 1080)).toBeGreaterThan(5000);
    expect(await rowsDiffer(base, bottom, 0, 300)).toBe(0);
  });

  it('wraps long text, handles right-to-left scripts and escapes markup', async () => {
    const base = await grey();
    const long = await renderOverlay(base, { text: 'A very long headline that needs to wrap over several lines to fit the picture nicely '.repeat(3), position: 'CENTER', width: 1080, height: 1080 });
    expect((await sharp(long).metadata()).width).toBe(1080);
    const ar = await renderOverlay(base, { text: 'عصير كركديه طبيعي منعش', position: 'BOTTOM', width: 1080, height: 1080 });
    expect(await rowsDiffer(base, ar, 700, 1080)).toBeGreaterThan(5000);
    // Markup in merchant text is drawn as text, never interpreted.
    await expect(renderOverlay(base, { text: '<script>alert(1)</script> & "quotes"', position: 'TOP', width: 1080, height: 1080 })).resolves.toBeInstanceOf(Buffer);
  });

  it('uses brand colours when given', async () => {
    const out = await renderOverlay(await grey(), { text: 'Promo', position: 'TOP', width: 1080, height: 1080, bandColor: '#ff0000', textColor: '#ffffff' });
    const [r, g, b] = await px(out, 4, Math.round(1080 * 0.05) + 4);
    expect(r).toBeGreaterThan(g! + 40); // the red band shows (72% over grey)
    expect(b).toBeLessThan(r!);
  });

  it('only accepts known brand fonts', () => {
    expect(fontFamily('Playfair Display')).toBe("'Playfair Display', serif");
    expect(fontFamily('Inter')).toBe("'Inter', sans-serif");
    expect(fontFamily('evil"/><script>')).toBe('sans-serif');
    expect(fontFamily(null)).toBe('sans-serif');
  });

  it('places the logo in the requested corner', async () => {
    const logo = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const base = await grey();
    const out = await placeLogo(base, logo, 'BOTTOM_RIGHT', 1080, 1080);
    expect(await px(out, 1080 - 60, 1080 - 60)).toEqual([255, 0, 0]);
    expect(await px(out, 30, 30)).toEqual([128, 128, 128]);
  });
});

describe('sizing helpers', () => {
  it('fits to an exact size and reports upscaling', async () => {
    const small = await sceneBg(500, 500);
    const r = await resizeExact(small, 1080, 1350);
    expect(await sharp(r.data).metadata()).toMatchObject({ width: 1080, height: 1350 });
    expect(r.upscaled).toBe(true);
    const big = await sceneBg(1536, 1536);
    expect((await resizeExact(big, 1080, 1080)).upscaled).toBe(false);
    expect(await sharp(await fitCover(big, 600, 300)).metadata()).toMatchObject({ width: 600, height: 300 });
    expect((await sharp(await toJpeg(big)).metadata()).format).toBe('jpeg');
  });
});
