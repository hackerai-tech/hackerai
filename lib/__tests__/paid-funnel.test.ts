import {
  PAID_FUNNEL_EVENT_VERSION,
  normalizePaidFunnelLabel,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";

describe("paid funnel analytics helpers", () => {
  it("keeps the paid funnel event version authoritative", () => {
    expect(
      paidFunnelProperties({
        paid_funnel_event_version: 999,
        surface: "pricing_dialog",
      }),
    ).toEqual({
      paid_funnel_event_version: PAID_FUNNEL_EVENT_VERSION,
      surface: "pricing_dialog",
    });
  });

  it("accepts only compact analytics labels", () => {
    expect(normalizePaidFunnelLabel("pricing_dialog")).toBe("pricing_dialog");
    expect(normalizePaidFunnelLabel(" user@example.com ")).toBeUndefined();
    expect(normalizePaidFunnelLabel("free form label")).toBeUndefined();
  });
});
