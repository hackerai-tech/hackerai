import {
  PUBLIC_METADATA,
  PUBLIC_POSITIONING,
} from "@/lib/marketing/positioning";

describe("public positioning", () => {
  it("leads with authorized, practitioner-focused security work", () => {
    expect(PUBLIC_METADATA.description).toContain("authorized bug bounty");
    expect(PUBLIC_POSITIONING.description).toContain("exploit validation");
    expect(PUBLIC_POSITIONING.audience).toContain("security labs");
  });

  it("sets clear capability boundaries without weakening the product promise", () => {
    expect(PUBLIC_POSITIONING.boundary).toContain("end-to-end help");
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "“jailbroken,” “unrestricted,”",
    );
    expect(PUBLIC_POSITIONING.boundary).toContain("Provider policies");
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "no plan guarantees an answer to every request",
    );
    expect(PUBLIC_POSITIONING.footerBoundary).toContain("Authorized targets");
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
