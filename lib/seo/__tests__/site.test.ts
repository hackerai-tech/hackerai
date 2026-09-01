import { describe, expect, it } from "@jest/globals";

import {
  ORGANIZATION_JSON_LD,
  SOFTWARE_APPLICATION_JSON_LD,
  SITE_URL,
  canonicalMetadata,
} from "../site";
import { PRICING } from "@/lib/pricing/config";

describe("public site metadata", () => {
  it("builds self-referencing canonical paths against the site metadata base", () => {
    expect(SITE_URL).toBe("https://hackerai.co");
    expect(canonicalMetadata("/product")).toEqual({
      alternates: { canonical: "/product" },
    });
  });

  it("publishes supported organization and software application entities", () => {
    expect(ORGANIZATION_JSON_LD).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://hackerai.co/#organization",
      name: "HackerAI",
      url: "https://hackerai.co",
    });
    expect(SOFTWARE_APPLICATION_JSON_LD).toMatchObject({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "@id": "https://hackerai.co/product#software-application",
      name: "HackerAI",
      url: "https://hackerai.co/product",
      publisher: { "@id": "https://hackerai.co/#organization" },
    });
    expect(SOFTWARE_APPLICATION_JSON_LD.offers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "Offer",
          name: "HackerAI Free",
          price: "0",
          priceCurrency: "USD",
        }),
        expect.objectContaining({
          "@type": "Offer",
          name: "HackerAI Pro",
          price: String(PRICING.pro.monthly),
          priceCurrency: "USD",
        }),
      ]),
    );
  });
});
