import sharp from "sharp";
import { mkdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "../src-tauri/icons");
const sourceSvg = join(iconsDir, "HackerAI.svg");

async function createIcon(svgBuffer, size, filename) {
  await sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(join(iconsDir, filename));
  console.log(`Created ${filename}`);
}

async function createIcns(svgBuffer) {
  const iconsetDir = join(iconsDir, "icon.iconset");
  await mkdir(iconsetDir, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of sizes) {
    await sharp(svgBuffer)
      .resize(s, s)
      .png()
      .toFile(join(iconsetDir, `icon_${s}x${s}.png`));

    if (s <= 512) {
      await sharp(svgBuffer)
        .resize(s * 2, s * 2)
        .png()
        .toFile(join(iconsetDir, `icon_${s}x${s}@2x.png`));
    }
  }

  console.log("Created iconset directory");
  return iconsetDir;
}

async function createIco(svgBuffer) {
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(join(iconsDir, "icon.png"));
  console.log("Created icon.png for ICO conversion");
}

async function main() {
  await mkdir(iconsDir, { recursive: true });
  const svgBuffer = await readFile(sourceSvg);

  await createIcon(svgBuffer, 32, "32x32.png");
  await createIcon(svgBuffer, 128, "128x128.png");
  await createIcon(svgBuffer, 256, "128x128@2x.png");

  const iconsetDir = await createIcns(svgBuffer);
  await createIco(svgBuffer);

  console.log("\nIcon generation complete!");
  console.log("\nTo create macOS .icns file, run:");
  console.log(
    `  iconutil -c icns "${iconsetDir}" -o "${join(iconsDir, "icon.icns")}"`,
  );
}

main().catch(console.error);
