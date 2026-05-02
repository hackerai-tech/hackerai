import { describe, it, expect } from "@jest/globals";
import { getSuspensionMessage } from "../suspensionMessage";

const SUPPORT_URL = "https://help.hackerai.co/";

describe("getSuspensionMessage", () => {
  it("uses the EFW label for early_fraud_warning reasons", () => {
    const msg = getSuspensionMessage("early_fraud_warning:fraudulent");
    expect(msg).toContain("a fraud warning from your card issuer");
    expect(msg).toContain(SUPPORT_URL);
  });

  it("uses the dispute label for dispute_fraudulent reasons", () => {
    const msg = getSuspensionMessage("dispute_fraudulent:dp_123");
    expect(msg).toContain("a fraudulent payment dispute (chargeback)");
    expect(msg).toContain(SUPPORT_URL);
  });

  it("falls back to the generic label when the reason is missing", () => {
    expect(getSuspensionMessage(undefined)).toContain("suspicious activity");
    expect(getSuspensionMessage(null)).toContain("suspicious activity");
    expect(getSuspensionMessage("")).toContain("suspicious activity");
  });

  it("falls back to the generic label for unknown categories", () => {
    expect(getSuspensionMessage("card_testing_detected:foo")).toContain(
      "suspicious activity",
    );
    expect(getSuspensionMessage("immediate_block:stolen_card")).toContain(
      "suspicious activity",
    );
    expect(getSuspensionMessage("totally_unknown")).toContain(
      "suspicious activity",
    );
  });

  it("does not leak detection internals after the colon", () => {
    const msg = getSuspensionMessage("early_fraud_warning:fraudulent");
    expect(msg).not.toContain("fraudulent");
    expect(msg).not.toContain("early_fraud_warning");
  });
});
