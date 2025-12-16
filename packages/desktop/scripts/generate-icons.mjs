import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '../src-tauri/icons');

// HackerAI brand color - dark emerald green
const brandColor = { r: 16, g: 185, b: 129 }; // #10b981

async function createIcon(size, filename) {
  // Create a simple icon with the brand color and "H" letter
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#10b981;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#059669;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="url(#grad)"/>
      <text
        x="50%"
        y="50%"
        dominant-baseline="central"
        text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-weight="bold"
        font-size="${size * 0.6}"
        fill="white"
      >H</text>
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(join(iconsDir, filename));

  console.log(`Created ${filename}`);
}

async function createIcns() {
  // For macOS .icns, we need to create a 1024x1024 PNG first
  // then use iconutil (macOS only) to convert
  const size = 1024;
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#10b981;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#059669;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="url(#grad)"/>
      <text
        x="50%"
        y="50%"
        dominant-baseline="central"
        text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-weight="bold"
        font-size="${size * 0.6}"
        fill="white"
      >H</text>
    </svg>
  `;

  const iconsetDir = join(iconsDir, 'icon.iconset');
  await mkdir(iconsetDir, { recursive: true });

  // Create all required sizes for iconset
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of sizes) {
    await sharp(Buffer.from(svg))
      .resize(s, s)
      .png()
      .toFile(join(iconsetDir, `icon_${s}x${s}.png`));

    // Also create @2x versions (except for 1024)
    if (s <= 512) {
      await sharp(Buffer.from(svg))
        .resize(s * 2, s * 2)
        .png()
        .toFile(join(iconsetDir, `icon_${s}x${s}@2x.png`));
    }
  }

  console.log('Created iconset directory');
  return iconsetDir;
}

async function createIco() {
  // For Windows .ico, we create a multi-resolution PNG
  // sharp can create ICO directly
  const size = 256;
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#10b981;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#059669;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="url(#grad)"/>
      <text
        x="50%"
        y="50%"
        dominant-baseline="central"
        text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-weight="bold"
        font-size="${size * 0.6}"
        fill="white"
      >H</text>
    </svg>
  `;

  // Create PNG that will be used as ico source
  await sharp(Buffer.from(svg))
    .png()
    .toFile(join(iconsDir, 'icon.png'));

  console.log('Created icon.png for ICO conversion');
}

async function main() {
  await mkdir(iconsDir, { recursive: true });

  // Create PNG icons
  await createIcon(32, '32x32.png');
  await createIcon(128, '128x128.png');
  await createIcon(256, '128x128@2x.png');

  // Create iconset for macOS
  const iconsetDir = await createIcns();

  // Create PNG for ICO
  await createIco();

  console.log('\nIcon generation complete!');
  console.log('\nTo create macOS .icns file, run:');
  console.log(`  iconutil -c icns "${iconsetDir}" -o "${join(iconsDir, 'icon.icns')}"`);
  console.log('\nFor Windows .ico, you can use an online converter or png2ico tool.');
  console.log('For now, Tauri will use the PNG files as fallback.');
}

main().catch(console.error);
