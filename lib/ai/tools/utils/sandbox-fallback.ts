import type { UIMessage, UIMessageStreamWriter } from "ai";
import { ChatSDKError } from "@/lib/errors";
import type { SandboxFallbackInfo } from "./hybrid-sandbox-manager";

type SandboxContextForPromptManager = {
  getSandboxInfo?: () => unknown;
  getSandboxContextForPrompt?: () => Promise<string | null>;
  consumeFallbackInfo?: () => SandboxFallbackInfo | null;
};

const escapePromptText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const LOCAL_HOST_PATTERNS: RegExp[] = [
  /\b[C-Z]:[\\/]/i,
  /\b[C-Z]:\s*(?:drive|path|folder|directory|file|share|volume)\b/i,
  /\b(?:drive|path|folder|directory|file|share|volume)\s+[`'"]?[C-Z]:\b/i,
  /(?:^|[\s`'"])(?:~\/|\/Users\/|\/Volumes\/|\/Applications\/|\/mnt\/[a-z]\/|\/media\/|\/run\/media\/)/i,
  /(?:^|[\s`'"])\/home\/(?!user(?:\/|\s|$))[A-Za-z0-9._-]+(?:\/|\b)/i,
  /\b(?:localhost|127\.0\.0\.1|::1|host\.docker\.internal)\b/i,
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/,
  /\b(?:private\s+(?:lan|network)|local\s+(?:dev\s+)?server|internal\s+(?:ip|network|host|service)|vpn)\b/i,
  /\b(?:my|this|the)\s+(?:laptop|desktop|computer|machine|host|pc)\b/i,
  /\b(?:desktop app|local machine|host machine|local filesystem|host filesystem|browser profile)\b/i,
];

const LOCAL_FALLBACK_BLOCK_MESSAGE =
  "Local sandbox is unavailable, and this request appears to need your local machine. Cloud cannot access your host files, drives, localhost, private networks, or desktop apps. Reconnect Desktop or a Remote Connection, then send the message again.";

const SELECTED_LOCAL_FALLBACK_BLOCK_MESSAGE =
  "The selected local sandbox is unavailable, and this request appears to need that machine. HackerAI did not switch sandboxes because commands would run on the wrong host. Reconnect or select the right local sandbox, then send the message again.";

const LOCAL_ATTACHMENT_BLOCK_MESSAGE =
  "Desktop-local attachments require the Desktop sandbox. Reconnect Desktop, then resend the message with the attachment.";

function getLastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;

    return (message.parts ?? [])
      .map((part) => {
        if (part.type !== "text") return "";
        return typeof part.text === "string" ? part.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

export function requestNeedsLocalHost(messages: UIMessage[]): boolean {
  const lastUserText = getLastUserText(messages);
  return LOCAL_HOST_PATTERNS.some((pattern) => pattern.test(lastUserText));
}

export function assertLocalSandboxFallbackAllowed({
  fallbackInfo,
  messages,
  requireLocalSandbox = false,
}: {
  fallbackInfo: SandboxFallbackInfo | null;
  messages: UIMessage[];
  requireLocalSandbox?: boolean;
}): void {
  if (!fallbackInfo?.occurred) {
    return;
  }

  if (requireLocalSandbox) {
    throw new ChatSDKError("bad_request:api", LOCAL_ATTACHMENT_BLOCK_MESSAGE, {
      sandboxFallbackReason: fallbackInfo.reason,
      requestedPreference: fallbackInfo.requestedPreference,
      actualSandbox: fallbackInfo.actualSandbox,
      localSandboxRequired: true,
    });
  }

  if (!requestNeedsLocalHost(messages)) {
    return;
  }

  const message =
    fallbackInfo.actualSandbox === "e2b"
      ? LOCAL_FALLBACK_BLOCK_MESSAGE
      : SELECTED_LOCAL_FALLBACK_BLOCK_MESSAGE;

  throw new ChatSDKError("bad_request:api", message, {
    sandboxFallbackReason: fallbackInfo.reason,
    requestedPreference: fallbackInfo.requestedPreference,
    actualSandbox: fallbackInfo.actualSandbox,
    localHostRequest: true,
  });
}

export function writeSandboxFallbackEvent(
  writer: UIMessageStreamWriter,
  fallbackInfo: SandboxFallbackInfo,
  id: string,
): void {
  writer.write({
    type: "data-sandbox-fallback",
    id,
    data: fallbackInfo,
  });
}

export async function prepareSandboxContextForPrompt({
  sandboxManager,
  writer,
  eventId,
  onContextError,
}: {
  sandboxManager: SandboxContextForPromptManager;
  writer: UIMessageStreamWriter;
  eventId: string;
  onContextError?: (error: unknown) => void;
}): Promise<{
  sandboxContext: string | null;
  fallbackInfo: SandboxFallbackInfo | null;
}> {
  let sandboxContext: string | null = null;

  if (typeof sandboxManager.getSandboxContextForPrompt === "function") {
    try {
      sandboxContext = await sandboxManager.getSandboxContextForPrompt();
    } catch (error) {
      onContextError?.(error);
    }
  }

  const fallbackInfo = sandboxManager.consumeFallbackInfo?.() ?? null;
  if (fallbackInfo?.occurred) {
    writeSandboxFallbackEvent(writer, fallbackInfo, eventId);
    return { sandboxContext, fallbackInfo };
  }

  return { sandboxContext, fallbackInfo: null };
}

export function getSandboxFallbackPromptReminder(
  fallbackInfo: SandboxFallbackInfo | null,
): string | null {
  if (!fallbackInfo?.occurred) {
    return null;
  }

  if (fallbackInfo.actualSandbox === "e2b") {
    return `<sandbox_fallback>
Local sandbox unavailable. This run is using the Cloud sandbox. Cloud commands cannot access the user's Windows/macOS/Linux host files, drives such as C: or Z:, localhost, private LAN, or desktop apps. Do not promise host access or try to fix local host paths from Cloud. If the task requires the user's host, tell them to reconnect Desktop or a Remote Connection before continuing.
</sandbox_fallback>`;
  }

  const actualName = escapePromptText(
    fallbackInfo.actualSandboxName || "another local sandbox",
  );
  return `<sandbox_fallback>
The selected local sandbox is unavailable. This run switched to ${actualName}. Commands run only on that connected machine; do not assume access to the originally selected host.
</sandbox_fallback>`;
}
