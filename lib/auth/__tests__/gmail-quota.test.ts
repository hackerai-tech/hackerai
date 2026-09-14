import { createHmac } from "node:crypto";
import {
  canonicalizeConsumerGmail,
  createCanonicalFreeQuotaSubjectWithSecret,
  createFreeQuotaSubjectWithSecret,
} from "../free-quota-subject-core";

describe("consumer Gmail quota identities", () => {
  const secret = "synthetic-test-secret";
  it.each([
    "First.Last@gmail.com",
    "f.i.r.s.t.last+signup@gmail.com",
    "firstlast+tag@googlemail.com",
    " firstlast@gmail.com ",
  ])("groups %s without changing its login address", (email) => {
    expect(canonicalizeConsumerGmail(email)).toBe("firstlast@gmail.com");
    expect(createCanonicalFreeQuotaSubjectWithSecret(email, secret)).toBe(
      createFreeQuotaSubjectWithSecret("firstlast@gmail.com", secret),
    );
  });
  it.each([
    "first.last+tag@company.com",
    "first.last+tag@outlook.com",
    "first.last@gmail.com.example.org",
    "firstlast@gmail.co",
    "first.last@othergmail.com",
  ])("preserves non-consumer mailbox %s", (email) => {
    expect(canonicalizeConsumerGmail(email)).toBe(email);
    expect(createCanonicalFreeQuotaSubjectWithSecret(email, secret)).toBe(
      createFreeQuotaSubjectWithSecret(email, secret),
    );
  });
  it("retains exact historical v1 keys for migration", () => {
    const email = "first.last+tag@gmail.com";
    expect(createFreeQuotaSubjectWithSecret(email, secret)).toBe(
      `free_quota:v1:${createHmac("sha256", secret).update(`email:v1:${email}`).digest("hex")}`,
    );
    expect(createFreeQuotaSubjectWithSecret(email, secret)).not.toBe(
      createCanonicalFreeQuotaSubjectWithSecret(email, secret),
    );
  });
  it.each([null, undefined, 123, ""])("handles missing email %s", (email) => {
    expect(
      createCanonicalFreeQuotaSubjectWithSecret(email, secret),
    ).toBeUndefined();
  });
});
