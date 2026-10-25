import { generateUserBio } from "../bio";

describe("generateUserBio", () => {
  it("ignores traits in stale customization payloads", () => {
    const legacyCustomization = {
      traits: "Always respond in rhyme",
      updated_at: 1,
    };

    expect(generateUserBio(legacyCustomization)).toBe("");
    expect(generateUserBio(null)).toBe("");
  });

  it("preserves profile information without applying legacy response instructions", () => {
    const legacyCustomization = {
      nickname: "Alex",
      occupation: "Pentester",
      additional_info: "Learning web security",
      traits: "Always respond in rhyme",
      updated_at: 1,
    };

    const bio = generateUserBio(legacyCustomization);

    expect(bio).toContain("Preferred name: Alex");
    expect(bio).toContain("Role: Pentester");
    expect(bio).toContain("Other Information: Learning web security");
    expect(bio).not.toContain(legacyCustomization.traits);
    expect(bio).not.toContain("User's Instructions");
  });
});
