import type { SandboxMessage } from "./types";

interface CentrifugoPublishRequest {
  channel: string;
  data: SandboxMessage;
}

interface CentrifugoPublishResponse {
  error?: {
    code: number;
    message: string;
  };
}

export async function publishCommand(
  channel: string,
  data: SandboxMessage,
): Promise<void> {
  const apiUrl = process.env.CENTRIFUGO_API_URL;
  const apiKey = process.env.CENTRIFUGO_API_KEY;

  if (!apiUrl) {
    throw new Error("CENTRIFUGO_API_URL environment variable is not set");
  }
  if (!apiKey) {
    throw new Error("CENTRIFUGO_API_KEY environment variable is not set");
  }

  const body: CentrifugoPublishRequest = { channel, data };

  const response = await fetch(`${apiUrl}/api/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `apikey ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Centrifugo publish failed: ${response.status} ${response.statusText}`,
    );
  }

  const result: CentrifugoPublishResponse = await response.json();

  if (result.error) {
    throw new Error(
      `Centrifugo publish error: [${result.error.code}] ${result.error.message}`,
    );
  }
}
