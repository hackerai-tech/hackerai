jest.mock("server-only", () => ({}));
import {
  abuseFingerprints,
  encryptAbuseEvidence,
  decryptAbuseEvidence,
} from "../evidence";
import { isAbuseTelemetry } from "../privacy";

const original = process.env.ABUSE_EVIDENCE_KEYS;
afterEach(() => {
  if (original === undefined) delete process.env.ABUSE_EVIDENCE_KEYS;
  else process.env.ABUSE_EVIDENCE_KEYS = original;
});
test("retained keys allow identical retries and decryption after active-key rotation", () => {
  const keys = { old: "11".repeat(32), next: "22".repeat(32) };
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "old",
    keys: { old: keys.old },
  });
  const report = {
    description: "Synthetic private report",
    email: "reporter@example.test",
  };
  const saved = encryptAbuseEvidence("AB-fixture", report);
  const digest = abuseFingerprints("submission", JSON.stringify(report))[0];
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({ active: "next", keys });
  expect(abuseFingerprints("submission", JSON.stringify(report))).toContain(
    digest,
  );
  expect(
    abuseFingerprints(
      "submission",
      JSON.stringify({ ...report, description: "changed" }),
    ),
  ).not.toContain(digest);
  expect(decryptAbuseEvidence("AB-fixture", saved)).toEqual(report);
  expect(saved).not.toContain(report.description);
  expect(() => decryptAbuseEvidence("AB-other", saved)).toThrow(
    "could not be read",
  );
  expect(() =>
    decryptAbuseEvidence("AB-fixture", saved.slice(0, -4) + "AAAA"),
  ).toThrow("could not be read");
});
test.each(["/abuse", "/abuse/operations", "/api/abuse", "/api/internal/abuse"])(
  "drops signed-in or anonymous events on %s and delayed exceptions after navigation",
  (path) => {
    expect(isAbuseTelemetry(path, { private: "synthetic" })).toBe(true);
    expect(
      isAbuseTelemetry("/", { $exception_url: `https://hackerai.co${path}` }),
    ).toBe(true);
    expect(
      isAbuseTelemetry("/", { $current_url: `https://hackerai.co${path}` }),
    ).toBe(true);
  },
);
