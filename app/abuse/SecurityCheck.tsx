"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Turnstile = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
const api = () => (window as Window & { turnstile?: Turnstile }).turnstile;

export default function SecurityCheck({
  siteKey,
  resetKey,
  onToken,
}: {
  siteKey: string;
  resetKey: number;
  onToken: (token: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState<boolean | null>(null);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<
    "loading" | "checking" | "verified" | "expired" | "failed"
  >("loading");

  useEffect(() => {
    const node = container.current!;
    const resize = () => setCompact(node.getBoundingClientRect().width < 300);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (compact === null) return;
    let disposed = false;
    let widget: string | undefined;
    let script: HTMLScriptElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onToken(null);
    const failed = () => {
      if (disposed) return;
      onToken(null);
      setState("failed");
    };
    const render = () => {
      clearTimeout(timer);
      if (disposed) return;
      try {
        const turnstile = api();
        if (!turnstile) return failed();
        setState("checking");
        widget = turnstile.render(container.current!, {
          sitekey: siteKey,
          action: "abuse_report",
          theme: "auto",
          size: compact ? "compact" : "flexible",
          "response-field": false,
          retry: "never",
          "refresh-expired": "auto",
          "refresh-timeout": "auto",
          callback: (token: string) => {
            if (disposed) return;
            if (!token || token.length > 2048) return failed();
            onToken(token);
            setState("verified");
          },
          "expired-callback": () => {
            if (disposed) return;
            onToken(null);
            setState("expired");
          },
          "error-callback": failed,
          "timeout-callback": failed,
          "unsupported-callback": failed,
        });
      } catch {
        failed();
      }
    };
    if (api()) render();
    else {
      // Own the load attempt so retry can replace a failed script without a page reload.
      script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = render;
      script.onerror = failed;
      document.head.appendChild(script);
      timer = setTimeout(failed, 15_000);
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (script) {
        script.onload = null;
        script.onerror = null;
        script.remove();
      }
      if (widget !== undefined) api()?.remove(widget);
    };
  }, [siteKey, resetKey, retry, compact, onToken]);

  return (
    <section
      id="security-check"
      tabIndex={-1}
      aria-labelledby="security-check-label"
      className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3 id="security-check-label" className="text-sm font-medium">
        Security check
      </h3>
      <p className="text-[13px] leading-5 text-muted-foreground">
        Cloudflare Turnstile helps prevent automated submissions.
      </p>
      <div ref={container} />
      <p
        id="security-check-status"
        role="status"
        className="text-[13px] leading-5 text-muted-foreground"
      >
        {state === "verified"
          ? "Security check complete. Submit your report to send it for review."
          : state === "failed"
            ? "The security check could not finish. Your report is still here."
            : state === "expired"
              ? "The security check expired. Getting a new check; your report is still here."
              : state === "loading"
                ? "Loading security check…"
                : "Complete the security check, then submit."}
      </p>
      {state === "failed" && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => {
            setState("loading");
            setRetry((value) => value + 1);
          }}
        >
          Retry security check
        </Button>
      )}
    </section>
  );
}
