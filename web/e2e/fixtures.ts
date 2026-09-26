// E2E 用の合成PDFを pdf-lib で作る(e2e/.fixtures/ に書き出す。リポジトリには含めない)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import {
  degrees,
  PDFDocument,
  PDFName,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, ".fixtures");
const REPO = join(HERE, "..", "..");

/** 最小限の PNG(RGB 8bit)を作る */
const png = (
  w: number,
  h: number,
  pixel: (x: number, y: number) => readonly [number, number, number]
): Uint8Array => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** JPEG は Python(Pillow。uv sync 済みの .venv)で作る */
const jpeg = (w: number, h: number): Uint8Array =>
  execFileSync(join(REPO, ".venv", "bin", "python"), [
    "-c",
    [
      "import io,sys",
      "from PIL import Image",
      `im=Image.new('RGB',(${w},${h}))`,
      `im.putdata([((x*7)%256,(y*5)%256,((x+y)*3)%256) for y in range(${h}) for x in range(${w})])`,
      "b=io.BytesIO(); im.save(b,'JPEG',quality=80); sys.stdout.buffer.write(b.getvalue())",
    ].join("\n"),
  ]);

const circlePath = (r: number) =>
  `M ${r} 0 C ${r} ${r * 0.5523} ${r * 0.5523} ${r} 0 ${r} C ${-r * 0.5523} ${r} ${-r} ${r * 0.5523} ${-r} 0 C ${-r} ${-r * 0.5523} ${-r * 0.5523} ${-r} 0 ${-r} C ${r * 0.5523} ${-r} ${r} ${-r * 0.5523} ${r} 0 Z`;

const drawVectors = async (doc: PDFDocument, page: PDFPage) => {
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const colors = [rgb(0, 0, 0), rgb(0.5, 0.5, 0.5), rgb(0.8, 0.1, 0.1)];
  const widths = [0, 0.5, 1, 2];
  for (const [i, w] of widths.entries()) {
    for (const [j, color] of colors.entries()) {
      const y = 780 - (i * 3 + j) * 14;
      page.drawLine({
        color,
        end: { x: 250 + i * 10, y },
        start: { x: 40, y },
        thickness: w,
      });
    }
  }
  // 同じ長さの線(長さの属性で選ばれる)
  for (let k = 0; k < 4; k += 1) {
    page.drawLine({
      end: { x: 300 + k * 20, y: 700 },
      start: { x: 300 + k * 20, y: 600 },
      thickness: 1,
    });
  }
  // 矩形
  page.drawRectangle({ borderWidth: 1, height: 40, width: 60, x: 40, y: 560 });
  page.drawRectangle({ borderWidth: 1, height: 20, width: 90, x: 120, y: 560 });
  page.drawRectangle({
    borderColor: rgb(0.2, 0.4, 0.8),
    borderWidth: 2,
    height: 30,
    width: 30,
    x: 230,
    y: 560,
  });
  // 相似な閉曲線(大きさ違い)と開曲線(S字、順・逆・鏡像)
  for (const [k, r] of [10, 20, 35].entries()) {
    page.drawSvgPath(circlePath(r), {
      borderWidth: 1,
      x: 80 + k * 90,
      y: 470,
    });
  }
  page.drawSvgPath("M 0 0 C 30 40 60 -40 90 0", {
    borderWidth: 1,
    x: 40,
    y: 380,
  });
  page.drawSvgPath("M 90 0 C 60 -40 30 40 0 0", {
    borderWidth: 1,
    x: 160,
    y: 380,
  });
  page.drawSvgPath("M 0 0 C 30 -40 60 40 90 0", {
    borderWidth: 1.5,
    x: 280,
    y: 380,
  });
  // 文字(フォント・サイズ・色・回転)
  page.drawText("Hello PDF Unit", { font: helv, size: 12, x: 40, y: 320 });
  page.drawText("Hello Again", { font: helv, size: 12, x: 200, y: 320 });
  page.drawText("Times 8pt", { font: times, size: 8, x: 40, y: 300 });
  page.drawText("Courier", {
    color: rgb(0.8, 0.1, 0.1),
    font: courier,
    size: 10,
    x: 150,
    y: 300,
  });
  page.drawText("Rotated", {
    font: helv,
    rotate: degrees(30),
    size: 14,
    x: 300,
    y: 280,
  });
  // 文字に重なる線(線を優先して選ぶ)
  page.drawText("UNDER", { font: helv, size: 20, x: 40, y: 240 });
  page.drawLine({ end: { x: 120, y: 247 }, start: { x: 30, y: 247 } });
  // ごく近い細線
  for (let k = 0; k < 5; k += 1) {
    page.drawLine({
      end: { x: 400, y: 200 + k * 0.1 },
      start: { x: 300, y: 200 + k * 0.1 },
      thickness: 0.05,
    });
  }
};

const drawImages = async (doc: PDFDocument, page: PDFPage) => {
  const pic = await doc.embedPng(
    png(40, 30, (x, y) => [x * 6, y * 8, 128] as const)
  );
  const jpg = await doc.embedJpg(jpeg(48, 32));
  const tiny = await doc.embedPng(
    png(4, 4, (x, y) => ((x + y) % 2 ? [0, 0, 0] : [255, 255, 0]))
  );
  page.drawImage(pic, { height: 90, width: 120, x: 40, y: 600 });
  page.drawImage(jpg, { height: 80, width: 120, x: 200, y: 600 });
  page.drawImage(pic, {
    height: 60,
    rotate: degrees(25),
    width: 80,
    x: 380,
    y: 580,
  });
  page.drawImage(tiny, { height: 100, width: 100, x: 40, y: 420 });
  // 隙間なく並んだ画像
  for (let k = 0; k < 3; k += 1) {
    page.drawImage(pic, { height: 60, width: 80, x: 200 + k * 80, y: 420 });
  }
  page.drawLine({ end: { x: 480, y: 450 }, start: { x: 180, y: 450 } });
};

const save = async (name: string, doc: PDFDocument) => {
  writeFileSync(join(FIXTURE_DIR, name), await doc.save());
};

export const generateFixtures = async (): Promise<void> => {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const vectors = await PDFDocument.create();
  await drawVectors(vectors, vectors.addPage([595, 842]));
  await drawImages(vectors, vectors.addPage([595, 842]));
  await save("vectors.pdf", vectors);

  // 回転・CropBox
  const geometry = await PDFDocument.create();
  const r90 = geometry.addPage([400, 300]);
  r90.setRotation(degrees(90));
  await drawVectors(geometry, r90);
  const r270 = geometry.addPage([300, 200]);
  r270.setRotation(degrees(270));
  r270.drawLine({ end: { x: 250, y: 150 }, start: { x: 20, y: 20 } });
  const cropped = geometry.addPage([500, 500]);
  cropped.setCropBox(50, 50, 300, 200);
  cropped.drawLine({ end: { x: 300, y: 200 }, start: { x: 60, y: 60 } });
  await save("geometry.pdf", geometry);

  // 25ページ(大きさ混在。サムネイルのバッチ3つ)
  const multi = await PDFDocument.create();
  const helv = await multi.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 25; i += 1) {
    const p = multi.addPage(i % 3 === 0 ? [842, 595] : [595, 842]);
    p.drawText(`Page ${i + 1}`, { font: helv, size: 36, x: 60, y: 300 });
    p.drawLine({ end: { x: 500, y: 100 + i * 10 }, start: { x: 60, y: 100 } });
  }
  await save("multipage.pdf", multi);

  // 1ページで 4MB を超える(圧縮できない画像)ページと、普通のページ
  const heavy = await PDFDocument.create();
  heavy.addPage([595, 842]).drawText("light page", { size: 20, x: 50, y: 700 });
  const bytes = randomBytes(1300 * 1200 * 3);
  const noise = await heavy.embedPng(
    png(1300, 1200, (x, y) => {
      const o = (y * 1300 + x) * 3;
      return [bytes[o] ?? 0, bytes[o + 1] ?? 0, bytes[o + 2] ?? 0] as const;
    })
  );
  heavy
    .addPage([595, 842])
    .drawImage(noise, { height: 500, width: 540, x: 30, y: 200 });
  await save("heavy.pdf", heavy);

  // 暗号化されたPDF(pdf-lib は trailer の /Encrypt を見て読み込みを拒否する)
  const enc = await PDFDocument.create();
  enc.addPage([200, 200]);
  enc.context.trailerInfo.Encrypt = enc.context.obj({
    Filter: PDFName.of("Standard"),
  });
  await save("encrypted.pdf", enc);

  writeFileSync(join(FIXTURE_DIR, "not-a-pdf.pdf"), "this is not a pdf\n");

  const empty = await PDFDocument.create();
  empty.addPage([300, 300]);
  await save("empty.pdf", empty);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateFixtures();
  console.log(`fixtures: ${FIXTURE_DIR}`);
}
