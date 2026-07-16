import {
  PUBLIC_METADATA,
  PUBLIC_POSITIONING,
} from "@/lib/marketing/positioning";

describe("public positioning", () => {
  it("leads with broad, individual-first technical work", () => {
    expect(PUBLIC_METADATA.description).toContain("individuals");
    expect(PUBLIC_POSITIONING.description).toContain("automation");
    expect(PUBLIC_POSITIONING.description).toContain(
      "authorized security testing",
    );
    expect(PUBLIC_POSITIONING.audience).toContain(
      "Built first for individuals",
    );
  });

  it("sets clear capability boundaries without weakening the product promise", () => {
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "end-to-end help across technical work",
    );
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "“jailbroken,” “unrestricted,”",
    );
    expect(PUBLIC_POSITIONING.boundary).toContain("Provider policies");
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "no plan guarantees an answer to every request",
    );
    expect(PUBLIC_POSITIONING.footerBoundary).toContain(
      "Only test systems you own",
    );
    expect(PUBLIC_POSITIONING.footerBoundary).toContain(
      "Model-provider policies",
    );
    expect(PUBLIC_POSITIONING.pricingBoundary).toContain(
      "do not bypass provider policies or abuse controls",
    );
    expect(PUBLIC_POSITIONING.pricingBoundary).toContain(
      "No plan guarantees every request will be answered",
    );
  });
});
