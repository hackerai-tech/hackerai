import type { CapacitorConfig } from "@capacitor/cli";

const APP_URL = process.env.APP_URL ?? "https://hackerai.co";
const APP_HOSTNAME = new URL(APP_URL).hostname;

const config: CapacitorConfig = {
  appId: "co.hackerai.ios",
  appName: "HackerAI",
  webDir: "src",
  ios: {
    scheme: "HackerAI",
    contentInset: "always",
  },
  server: {
    url: APP_URL,
    hostname: APP_HOSTNAME,
    iosScheme: "https",
    cleartext: false,
    allowNavigation: [
      "hackerai.co",
      "*.hackerai.co",
      "auth.workos.com",
      "*.workos.com",
      "*.convex.cloud",
      "*.convex.dev",
    ],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: "#0a0a0a",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
