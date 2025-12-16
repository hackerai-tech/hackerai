# HackerAI Desktop

Native desktop application for HackerAI built with [Tauri](https://tauri.app/).

## Overview

The desktop app wraps the HackerAI web application in a native shell, providing:

- **Native OAuth flow** via `hackerai://` deep links
- **Secure token storage** in OS keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux)
- **Local Docker sandbox** management for code execution
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

This opens the desktop app pointing to `https://hackerai.co`. The Rust backend hot-reloads on changes.

### Run with local web server

To develop against a local Next.js server, edit `src-tauri/tauri.conf.json`:

```json
{
  "build": {
    "devUrl": "http://localhost:3000"
  }
}
```

Then run:
```bash
# Terminal 1: Start the web app
pnpm dev:next

# Terminal 2: Start the desktop app
pnpm dev
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
│  ├─ auth.rs                    │  └─ Loads hackerai.co      │
│  │  ├─ OAuth deep link handler │                            │
│  │  ├─ Keychain storage        │                            │
│  │  └─ Token refresh           │                            │
│  ├─ docker.rs                  │                            │
│  │  ├─ Docker availability     │                            │
│  │  └─ Sandbox process mgmt    │                            │
│  └─ main.rs                    │                            │
│     └─ Plugin registration     │                            │
└─────────────────────────────────────────────────────────────┘
```

### Authentication Flow

1. User clicks "Login" → Rust opens system browser to `/api/desktop-auth/login`
2. Browser → WorkOS OAuth → `/api/desktop-auth/callback`
3. Server redirects to `hackerai://auth/callback?access_token=X&refresh_token=Y`
4. Tauri captures deep link, stores tokens in OS keychain
5. Tokens passed to Convex client for API authentication

### Rust Commands

Available Tauri commands (invoke from JavaScript):

**Authentication:**
- `start_login(base_url?)` - Initiates OAuth, returns URL to open
- `get_stored_tokens()` - Retrieves tokens from keychain
- `store_tokens(tokens)` - Stores tokens in keychain
- `refresh_tokens(refresh_token, base_url?)` - Refreshes access token
- `logout()` - Clears stored tokens
- `get_auth_status()` - Returns current auth state

**Docker/Sandbox:**
- `check_docker()` - Checks if Docker is available
- `check_sandbox_image(image?)` - Checks if sandbox image exists
- `pull_sandbox_image(image?)` - Pulls the sandbox image
- `start_sandbox(config)` - Starts local sandbox CLI
- `stop_sandbox()` - Stops running sandbox
- `get_sandbox_status()` - Returns sandbox state

## Configuration

### tauri.conf.json

Key settings:

| Setting | Description |
|---------|-------------|
| `build.devUrl` | URL to load in development |
| `app.security.csp` | Content Security Policy |
| `plugins.deep-link.desktop.schemes` | Custom URL schemes |
| `plugins.updater.endpoints` | Auto-update server URLs |

### Deep Link Protocol

The app registers `hackerai://` as a custom protocol:

- `hackerai://auth/callback?access_token=X&refresh_token=Y` - OAuth callback
- `hackerai://auth/error?reason=X` - OAuth error

## CI/CD

GitHub Actions workflow (`.github/workflows/desktop-build.yml`) builds for:

| Platform | Target | Output |
|----------|--------|--------|
| macOS | `aarch64-apple-darwin` | `.dmg`, `.app` |
| macOS | `x86_64-apple-darwin` | `.dmg`, `.app` |
| macOS | Universal | `.dmg` (combined) |
| Windows | `x86_64-pc-windows-msvc` | `.msi`, `.exe` |
| Linux | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb` |

### Triggering builds

**Via tag:**
```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

**Via workflow dispatch:**
Go to Actions → "Build Desktop App" → Run workflow

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

### Deep links not working

**macOS:** Check System Preferences → Privacy & Security → Default Apps

**Windows:** Re-run the app to re-register the protocol

**Linux:** Run:
```bash
xdg-mime default hackerai.desktop x-scheme-handler/hackerai
```

### Keychain access denied (macOS)

The app needs keychain access on first run. Click "Always Allow" when prompted.

## License

Proprietary - HackerAI
