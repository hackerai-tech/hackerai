import sharp from "sharp";
import { mkdir, readFile, copyFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceSvg = join(
  __dirname,
  "../../desktop/src-tauri/icons/HackerAI.svg",
);
const assetsDir = join(__dirname, "../assets");
const appIconDir = join(
  __dirname,
  "../ios/App/App/Assets.xcassets/AppIcon.appiconset",
);
const splashDir = join(
  __dirname,
  "../ios/App/App/Assets.xcassets/Splash.imageset",
);

const SPLASH_BG = "#0a0a0a";
const ICON_SIZE = 1024;
const SPLASH_SIZE = 2732;
const SPLASH_LOGO_SIZE = 768;

async function main() {
  await mkdir(assetsDir, { recursive: true });
  const svg = await readFile(sourceSvg);

  // 1024×1024 icon. iOS rounds corners + adds shadow itself.
  // Flatten alpha — App Store rejects icons with transparency.
  const iconPath = join(assetsDir, "icon-only.png");
  await sharp(svg)
    .resize(ICON_SIZE, ICON_SIZE)
    .flatten({ background: SPLASH_BG })
    .png()
    .toFile(iconPath);
  console.log(`✓ assets/icon-only.png  (${ICON_SIZE}×${ICON_SIZE})`);

  // Splash: centered logo on solid #0a0a0a canvas.
  const logoBuffer = await sharp(svg)
    .resize(SPLASH_LOGO_SIZE, SPLASH_LOGO_SIZE)
    .png()
    .toBuffer();

  const splashPath = join(assetsDir, "splash.png");
  await sharp({
    create: {
      width: SPLASH_SIZE,
      height: SPLASH_SIZE,
      channels: 4,
      background: SPLASH_BG,
    },
  })
    .composite([{ input: logoBuffer, gravity: "center" }])
    .png()
    .toFile(splashPath);
  console.log(`✓ assets/splash.png     (${SPLASH_SIZE}×${SPLASH_SIZE})`);

  // Drop into the Xcode asset catalog.
  await copyFile(iconPath, join(appIconDir, "AppIcon-512@2x.png"));
  console.log(`✓ AppIcon.appiconset/AppIcon-512@2x.png`);

  for (const name of [
    "splash-2732x2732.png",
    "splash-2732x2732-1.png",
    "splash-2732x2732-2.png",
  ]) {
    await copyFile(splashPath, join(splashDir, name));
    console.log(`✓ Splash.imageset/${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
