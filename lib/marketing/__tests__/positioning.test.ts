import {
  PUBLIC_METADATA,
  PUBLIC_POSITIONING,
} from "@/lib/marketing/positioning";

describe("public positioning", () => {
  it("leads with a hacker-first, individual-operator identity", () => {
    expect(PUBLIC_METADATA.title).toContain("Hacker's AI Workspace");
    expect(PUBLIC_METADATA.description).toContain("individual hackers");
    expect(PUBLIC_POSITIONING.headline).toBe("What will you hack today?");
    expect(PUBLIC_POSITIONING.description).toContain("Build the exploit");
    expect(PUBLIC_POSITIONING.description).toContain("Prove the impact");
    expect(PUBLIC_POSITIONING.audience).toContain(
      "Built for individual hackers",
    );
  });

  it("sets clear capability boundaries without weakening the product promise", () => {
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "go deep on authorized security work",
    );
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "“jailbroken,” “unrestricted,”",
    );
    expect(PUBLIC_POSITIONING.boundary).toContain("Provider policies");
    expect(PUBLIC_POSITIONING.boundary).toContain(
      "no plan guarantees an answer to every request",
    );
    expect(PUBLIC_POSITIONING.footerBoundary).toContain(
      "Hack only what you own",
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
