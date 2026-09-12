import {
  miosaExternalUserId,
  miosaIdentityMetadata,
  miosaUserReference,
  matchesMiosaUserReference,
} from "../miosa-identity";

describe("Miosa support identity", () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  it("keeps existing provider identities and resolves legacy names", () => {
    const external = miosaExternalUserId("user-1");
    expect(external).toBe("hackerai-c6c289e49e9c05b214586038");
    for (const reference of [
      external,
      `${external}-v2`,
      miosaUserReference("user-1"),
    ]) {
      expect(matchesMiosaUserReference("user-1", reference)).toBe(true);
      expect(matchesMiosaUserReference("user-2", reference)).toBe(false);
    }
    expect(matchesMiosaUserReference("user-1", "hackerai-user-c6c2")).toBe(
      false,
    );
  });

  it("uses the worker environment without leaking account details", () => {
    process.env = {
      TRIGGER_ENV: "preview",
      VERCEL_ENV: "production",
      NODE_ENV: "production",
    };
    const metadata = miosaIdentityMetadata("private@example.com");
    expect(metadata.environment).toBe("preview");
    expect(metadata.userReference).toMatch(/^hackerai-user-[a-f0-9]{12}$/);
    expect(JSON.stringify(metadata)).not.toContain("private@example.com");
    process.env = { NODE_ENV: "production" };
    expect(miosaIdentityMetadata("user-1").environment).toBe("unknown");
  });
});
