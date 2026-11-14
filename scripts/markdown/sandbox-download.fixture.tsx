// Bundled by sandbox-download.test.mjs with the real Streamdown pipeline and
// its default sanitizers; Jest replaces Streamdown with a stub.
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
import { SandboxAttachmentContext } from "@/app/components/SandboxAttachmentLink";
import { resolveSandboxAttachments } from "@/lib/chat/sandbox-attachment-links";
import type { FileDetails } from "@/types/file";

class OfflineWebSocket {
  constructor() {
    throw new Error("The Markdown fixture must not open a Convex connection");
  }
}

// The app root provides Convex auth; a static signed-out state keeps this
// offline: no token is ever fetched.
const fetchNoAccessToken = async () => null;
function useOfflineAuth() {
  return {
    isLoading: false,
    isAuthenticated: false,
    fetchAccessToken: fetchNoAccessToken,
  };
}

export interface FixtureDelivery {
  parts: unknown[];
  fileDetails: FileDetails[];
}

/**
 * Render assistant Markdown the way MessagePartHandler does: a message-scoped
 * attachment map when delivery data exists, otherwise no download access.
 */
export function renderAssistantMarkdown(
  markdown: string,
  delivery?: FixtureDelivery,
): string {
  // The client creates its socket lazily on the first query or action; server
  // rendering a link only binds the action and never reaches the network.
  const client = new ConvexReactClient("https://markdown-fixture.invalid", {
    logger: false,
    webSocketConstructor: OfflineWebSocket as unknown as typeof WebSocket,
  });
  const attachments = delivery
    ? resolveSandboxAttachments(delivery.parts, delivery.fileDetails)
    : null;
  try {
    return renderToStaticMarkup(
      <ConvexProviderWithAuth client={client} useAuth={useOfflineAuth}>
        <SandboxAttachmentContext.Provider value={attachments}>
          <MemoizedMarkdown content={markdown} />
        </SandboxAttachmentContext.Provider>
      </ConvexProviderWithAuth>,
    );
  } finally {
    void client.close();
  }
}
