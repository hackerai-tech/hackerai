import {
  logStripeWebhookMissingSignature,
  logStripeWebhookSignatureVerificationFailed,
} from "../stripe-webhook-logging";

describe("stripe webhook logging", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs signature failures without the raw payload or signature header", () => {
    const rawBody =
      '{"id":"evt_test_credit_001","metadata":{"label":"über","userId":"user_secret"}}';
    const expectedPayloadBytes = new TextEncoder().encode(rawBody).byteLength;
    const rawSignature =
      "t=1782534490,v1=fd2db5102f05f92772c0a9e2d0b07c314dde57f8352696e0318217c95ff5e527";
    const error = Object.assign(new Error("No signatures found matching"), {
      type: "StripeSignatureVerificationError",
      header: rawSignature,
      payload: rawBody,
    });

    logStripeWebhookSignatureVerificationFailed({
      logPrefix: "[Extra Usage Webhook]",
      webhook: "extra_usage",
      route: "/api/extra-usage/webhook",
      requestHeaders: new Headers({ "x-vercel-id": "iad1::abc123" }),
      body: rawBody,
      signature: rawSignature,
      error,
    });

    expect(console.warn).toHaveBeenCalledWith(
      "[Extra Usage Webhook] Signature verification failed",
      expect.objectContaining({
        event: "stripe_webhook_signature_verification_failed",
        level: "warn",
        service: "zhacker-web",
        webhook: "extra_usage",
        route: "/api/extra-usage/webhook",
        request_id: "iad1::abc123",
        payload_bytes: expectedPayloadBytes,
        signature_header_present: true,
        signature_timestamp: 1782534490,
        signature_has_v1: true,
        error_type: "StripeSignatureVerificationError",
        error_message: "No signatures found matching",
      }),
    );

    const serializedLogFields = JSON.stringify(
      (console.warn as jest.Mock).mock.calls[0][1],
    );
    expect(serializedLogFields).not.toContain(rawBody);
    expect(serializedLogFields).not.toContain(rawSignature);
    expect(serializedLogFields).not.toContain("user_secret");
    expect(serializedLogFields).not.toContain(
      "fd2db5102f05f92772c0a9e2d0b07c314dde57f8352696e0318217c95ff5e527",
    );
  });

  it("logs missing signatures as handled rejected webhook traffic", () => {
    const body = "{}";
    const expectedPayloadBytes = new TextEncoder().encode(body).byteLength;

    logStripeWebhookMissingSignature({
      logPrefix: "[Fraud Webhook]",
      webhook: "fraud",
      route: "/api/fraud/webhook",
      requestHeaders: new Headers(),
      body,
      signature: null,
    });

    expect(console.warn).toHaveBeenCalledWith(
      "[Fraud Webhook] Missing stripe-signature header",
      expect.objectContaining({
        event: "stripe_webhook_missing_signature",
        level: "warn",
        webhook: "fraud",
        payload_bytes: expectedPayloadBytes,
        signature_header_present: false,
        signature_has_v1: false,
      }),
    );
  });
});
