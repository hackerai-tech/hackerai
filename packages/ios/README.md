# @hackerai/ios

iOS app for HackerAI built with [Capacitor](https://capacitorjs.com/). The
app is a thin native shell around the production Next.js web app at
`https://hackerai.co`, plus the native plugins required to clear Apple App
Store Guideline 4.2 (push, share, biometrics, deep links).

## First-time setup

```bash
pnpm install
cd packages/ios
pnpm add:ios   # generates ios/ Xcode project (one-time)
pnpm sync      # copies web assets + Capacitor config into the Xcode project
pnpm open      # opens Xcode for signing + run
```

Requires:

- macOS with Xcode 15+
- Apple Developer account ($99/yr)
- (Capacitor 8 uses Swift Package Manager — no CocoaPods needed)

## Daily development

```bash
pnpm dev   # runs the app on a connected simulator or device
```

The app loads `https://hackerai.co` directly inside WKWebView. To point at
local dev, override the URL:

```bash
APP_URL=http://localhost:3000 pnpm sync && pnpm open
```

(Local dev requires `cleartext: true` in `capacitor.config.ts` and a network
that allows loopback to your dev machine.)

## App Store submission

1. Open `ios/App/App.xcodeproj` in Xcode.
2. Select "Any iOS Device" target, Product → Archive.
3. Distribute → App Store Connect → Upload.
4. From App Store Connect, push the build to TestFlight, then submit for
   review.

## Plugin map

| Plugin | Why |
|---|---|
| `@capacitor/push-notifications` | Native APNs for new replies — required for 4.2 |
| `@capacitor/share` | Native share sheet — required for 4.2 |
| `@capacitor/browser` | In-app browser for WorkOS OAuth (cookie bridge) |
| `@capacitor/app` | URL scheme + universal link handling |
| `@capacitor/splash-screen` + `@capacitor/status-bar` | Native chrome |
| `@aparajita/capacitor-biometric-auth` | Face ID / Touch ID gate |
| `@capacitor/preferences` | Keychain-backed token fallback |
