const mockConstruct = jest.fn();
const mockHandle = jest.fn();
jest.mock("@/app/api/stripe", () => ({
  stripe: { webhooks: { constructEvent: mockConstruct } },
}));
jest.mock("@/lib/influencers/stripe", () => ({
  handleInfluencerEvent: mockHandle,
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: () => ({}) }));
jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: {
    json: (body: unknown, options: any = {}) => ({
      status: options.status ?? 200,
      body,
    }),
  },
}));
const { POST } = require("../route") as typeof import("../route");
const req = () =>
  ({
    text: async () => "raw-body",
    headers: new Headers({ "stripe-signature": "test-signature" }),
  }) as any;
describe("influencer webhook", () => {
  beforeEach(() => {
    process.env.STRIPE_INFLUENCER_WEBHOOK_SECRET = "test-webhook";
    mockConstruct
      .mockReset()
      .mockReturnValue({ id: "evt_1", type: "invoice.paid" });
    mockHandle.mockReset().mockResolvedValue(undefined);
  });
  it("verifies the signature before handling any data", async () => {
    mockConstruct.mockImplementation(() => {
      throw new Error("bad signature");
    });
    expect((await POST(req())).status).toBe(400);
    expect(mockHandle).not.toHaveBeenCalled();
  });
  it("returns a retryable error when persistence fails", async () => {
    mockHandle.mockRejectedValue(new Error("unavailable"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(req())).status).toBe(500);
    spy.mockRestore();
  });
  it("accepts successfully reconciled deliveries", async () => {
    expect((await POST(req())).status).toBe(200);
    expect(mockConstruct).toHaveBeenCalledWith(
      "raw-body",
      "test-signature",
      "test-webhook",
    );
  });
});
