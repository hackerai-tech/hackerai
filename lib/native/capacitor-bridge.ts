"use client";

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform: () => boolean;
      getPlatform: () => "ios" | "android" | "web";
    };
  }
}

function detectCapacitor(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.Capacitor?.isNativePlatform === "function" &&
    window.Capacitor.isNativePlatform()
  );
}

export function isNativePlatform(): boolean {
  return detectCapacitor();
}

export function isIOS(): boolean {
  return (
    typeof window !== "undefined" && window.Capacitor?.getPlatform() === "ios"
  );
}

export async function openInAppBrowser(url: string): Promise<boolean> {
  if (!detectCapacitor()) return false;
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url, presentationStyle: "popover" });
    return true;
  } catch (err) {
    console.error("[Capacitor] Failed to open in-app browser:", err);
    return false;
  }
}

export async function shareContent(opts: {
  title?: string;
  text?: string;
  url?: string;
}): Promise<boolean> {
  if (!detectCapacitor()) return false;
  try {
    const { Share } = await import("@capacitor/share");
    await Share.share(opts);
    return true;
  } catch (err) {
    console.error("[Capacitor] Share failed:", err);
    return false;
  }
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!detectCapacitor()) return null;
  try {
    const { PushNotifications } = await import(
      "@capacitor/push-notifications"
    );

    const status = await PushNotifications.checkPermissions();
    if (status.receive !== "granted") {
      const req = await PushNotifications.requestPermissions();
      if (req.receive !== "granted") return null;
    }

    return await new Promise<string | null>((resolve) => {
      const cleanup = () => {
        PushNotifications.removeAllListeners();
      };
      const settle = (token: string | null) => {
        cleanup();
        resolve(token);
      };

      PushNotifications.addListener("registration", (t) => settle(t.value));
      PushNotifications.addListener("registrationError", (err) => {
        console.error("[Capacitor] APNs registration error:", err);
        settle(null);
      });

      void PushNotifications.register();

      // Safety timeout — registration shouldn't hang
      setTimeout(() => settle(null), 15_000);
    });
  } catch (err) {
    console.error("[Capacitor] Push setup failed:", err);
    return null;
  }
}

export async function listenForAppUrlOpen(
  handler: (url: string) => void,
): Promise<() => void> {
  if (!detectCapacitor()) return () => {};
  try {
    const { App } = await import("@capacitor/app");
    const sub = await App.addListener("appUrlOpen", (event) => {
      handler(event.url);
    });
    return () => {
      void sub.remove();
    };
  } catch (err) {
    console.error("[Capacitor] App URL listener failed:", err);
    return () => {};
  }
}
