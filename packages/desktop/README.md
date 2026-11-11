# HackerAI Desktop

Native desktop application for HackerAI built with [Tauri](https://tauri.app/).

## Overview

The desktop app wraps the HackerAI web application in a native shell, providing:

- **Native window** with system integration
- **Auto-updates** via Tauri's updater plugin
- **Cross-platform** builds for macOS, Windows, and Linux

## Prerequisites

### Required

- **Node.js** 20+
- **pnpm** 9+
- **Rust** 1.70+ ([install](https://rustup.rs/))

### Platform-specific

**macOS:**

```bash
xcode-select --install
```

**Ubuntu/Debian:**

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
```

**Windows:**

- Install [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Windows 10/11)
- Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++"

## Development

### Install dependencies

```bash
pnpm install
```

### Run in development mode

```bash
pnpm dev
```

This opens the desktop app pointing to `https://hackerai.co`.

### Run with local web server

To develop against a local Next.js server:

```bash
# Terminal 1: Start the web app (from repo root)
pnpm dev

# Terminal 2: Start the desktop app with dev config
pnpm dev --config src-tauri/tauri.dev.conf.json
```

## Building

### Development build

```bash
pnpm build
```

Outputs to `src-tauri/target/release/bundle/`.

### Production build with signing

Set environment variables:

```bash
export TAURI_SIGNING_PRIVATE_KEY="your-private-key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-password"
```

Then build:

```bash
pnpm build
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                        │
├─────────────────────────────────────────────────────────────┤
│  Rust Backend (src-tauri/)     │  WebView                   │
│  └─ main.rs/lib.rs             │  └─ Loads hackerai.co      │
│     └─ Plugin registration     │     (uses web auth flow)   │
└─────────────────────────────────────────────────────────────┘
```

The app is a thin native wrapper around the web application. Authentication and all features are handled by the web app.

## CI/CD

GitHub Actions workflow (`.github/workflows/desktop-build.yml`) builds for:

| Platform | Target                     | Output              |
| -------- | -------------------------- | ------------------- |
| macOS    | `aarch64-apple-darwin`     | `.dmg`, `.app`      |
| macOS    | `x86_64-apple-darwin`      | `.dmg`, `.app`      |
| macOS    | Universal                  | `.dmg` (combined)   |
| Windows  | `x86_64-pc-windows-msvc`   | `.msi`, `.exe`      |
| Linux    | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb` |

### Building and releasing

Desktop-related merges to `main` build a release candidate using the next
desktop patch version. After the `Build Desktop App` run succeeds (including
approval of the `trusted-signing` Windows job), promote those exact artifacts:

1. Copy the numeric run ID from the successful build URL.
2. Within the seven-day artifact retention window, dispatch promotion from a
   GitHub CLI session with repository write access:

   ```bash
   gh api -X POST repos/{owner}/{repo}/dispatches \
     -f event_type=desktop_promote \
     -f 'client_payload[source_run_id]=123456789'
   ```

   Replace `123456789` with that run ID. The `repository_dispatch` event runs
   the release workflow from `main`, regardless of the caller's checkout.

3. Review the generated draft release and publish it.

Promotion verifies the source run, embedded version, required platform assets,
and updater signatures. It creates the release tag with `GITHUB_TOKEN`.

If no valid candidate artifacts remain, request a new build from trusted `main`
workflow code, wait for it to pass, then promote its run ID:

```bash
gh api -X POST repos/{owner}/{repo}/dispatches -f event_type=desktop_build
```

Pushing a tag does not build or promote a Desktop release.

Keep repository Actions policies active for the historical workflow files:
`.github/workflows/desktop-promote.yml` permits only `repository_dispatch`, and
`.github/workflows/desktop-build.yml` permits only `workflow_run` and
`repository_dispatch`. These server-side rules reject old branch or tag versions
of the workflows that still declare manual or tag-push release triggers.

## Code Signing

### macOS

1. Get an Apple Developer ID certificate
2. Export as `.p12` file
3. Set in CI:
   - `APPLE_CERTIFICATE` (base64-encoded .p12)
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_SIGNING_IDENTITY`

### Windows

1. Get an EV code signing certificate
2. Set in CI:
   - Certificate details (varies by provider)

### Auto-update signing

Generate a key pair:

```bash
pnpm tauri signer generate -w ~/.tauri/hackerai.key
```

Set in CI:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Update `tauri.conf.json` with your public key:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6..."
    }
  }
}
```

## Troubleshooting

### "WebView2 not found" (Windows)

Install WebView2 from Microsoft: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### "gtk/webkit not found" (Linux)

Install development libraries:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev
```

## License

Proprietary - HackerAI
