import { describe, expect, it } from "@jest/globals";

import {
  ORGANIZATION_JSON_LD,
  SOFTWARE_APPLICATION_JSON_LD,
  SITE_URL,
  WEBSITE_JSON_LD,
  canonicalMetadata,
  formatPublicPageDate,
} from "../site";
import { PRICING } from "@/lib/pricing/config";

describe("public site metadata", () => {
  it("builds self-referencing canonical paths against the site metadata base", () => {
    expect(SITE_URL).toBe("https://hackerai.co");
    expect(canonicalMetadata("/product")).toEqual({
      alternates: { canonical: "/product" },
    });
    expect(formatPublicPageDate("2026-09-01")).toBe("September 1, 2026");
  });

  it.each([
    ["/", "https://hackerai.co/?utm_source=chatgpt&utm_medium=referral"],
    ["/product", "https://hackerai.co/product?ref=assistant"],
    ["/pricing", "https://hackerai.co/pricing?trk=partner"],
    [
      "/download",
      "https://hackerai.co/download?snoball_referral=campaign#desktop",
    ],
  ] as const)(
    "keeps the %s canonical clean for parameterized entry URLs",
    (path, entryUrl) => {
      const canonical = canonicalMetadata(path).alternates?.canonical;

      expect(canonical).toBe(path);
      expect(new URL(String(canonical), entryUrl).href).toBe(
        `${SITE_URL}${path}`,
      );
    },
  );

  it("publishes supported organization and software application entities", () => {
    expect(ORGANIZATION_JSON_LD).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://hackerai.co/#organization",
      name: "HackerAI",
      url: "https://hackerai.co",
    });
    expect(WEBSITE_JSON_LD).toMatchObject({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": "https://hackerai.co/#website",
      name: "HackerAI",
      url: "https://hackerai.co",
      publisher: { "@id": "https://hackerai.co/#organization" },
    });
    expect(SOFTWARE_APPLICATION_JSON_LD).toMatchObject({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "@id": "https://hackerai.co/product#software-application",
      name: "HackerAI",
      url: "https://hackerai.co/product",
      publisher: { "@id": "https://hackerai.co/#organization" },
    });
    const expectedOffers = [
      ["HackerAI Free", "0"],
      ["HackerAI Pro", String(PRICING.pro.monthly)],
      ["HackerAI Pro+", String(PRICING["pro-plus"].monthly)],
      ["HackerAI Ultra", String(PRICING.ultra.monthly)],
      ["HackerAI Team (per seat)", String(PRICING.team.monthly)],
    ];

    for (const [name, price] of expectedOffers) {
      expect(SOFTWARE_APPLICATION_JSON_LD.offers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            "@type": "Offer",
            name,
            price,
            priceCurrency: "USD",
          }),
        ]),
      );
    }
  });
});
