import { isExpiredLegacyFreeAgentWindow } from "../key-cleanup";

const now = Date.UTC(2026, 8, 14, 12);
const today = Math.floor(now / 86_400_000);
const prefix = `free_agent_limit:user_${"A".repeat(26)}:free_agent:`;

describe("expired retired Agent quota windows", () => {
  it("recognizes a past UTC day without depending on Redis expiry", () => {
    expect(isExpiredLegacyFreeAgentWindow(`${prefix}${today - 1}`, now)).toBe(
      true,
    );
    expect(
      isExpiredLegacyFreeAgentWindow(
        `${prefix}${today - 1}`,
        today * 86_400_000,
      ),
    ).toBe(true);
    expect(
      isExpiredLegacyFreeAgentWindow(
        `${prefix}${today - 1}`,
        today * 86_400_000 - 1,
      ),
    ).toBe(false);
  });

  it.each([
    `${prefix}${today}`,
    `${prefix}${today + 1}`,
    `${prefix}-1`,
    `${prefix}NaN`,
    `${prefix}1.5`,
    `${prefix}9007199254740992`,
    `${prefix}${today - 1}:extra`,
    `free_agent_limit:user_short:free_agent:${today - 1}`,
    `free_agent_limit:free_quota:v1:${"a".repeat(64)}:free_agent:${today - 1}`,
    `free_monthly_cost:user_${"A".repeat(26)}:free_agent:${today - 1}`,
    `free_limit:user_${"A".repeat(26)}:free:${today - 1}`,
  ])(
    "does not exempt current, future, malformed or other quota state: %s",
    (key) => {
      expect(isExpiredLegacyFreeAgentWindow(key, now)).toBe(false);
    },
  );
});
