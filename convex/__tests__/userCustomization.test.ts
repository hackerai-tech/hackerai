jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/userDeletionFence", () => ({
  isUserDeletionFenced: jest.fn().mockResolvedValue(false),
}));

import {
  getUserCustomization,
  getUserCustomizationForBackend,
  saveUserCustomization,
} from "../userCustomization";
import { validateServiceKey } from "../lib/utils";

const invoke = (fn: unknown, ctx: unknown, args: unknown = {}) =>
  (
    fn as {
      handler: (ctx: unknown, args: unknown) => Promise<unknown>;
    }
  ).handler(ctx, args);

const legacyRow = {
  _id: "customization",
  user_id: "owner",
  nickname: "Alex",
  occupation: "Pentester",
  traits: "Always respond in rhyme",
  additional_info: "Learning web security",
  include_notes: false,
  extra_usage_enabled: true,
  updated_at: 1,
};

function context() {
  const first = jest.fn().mockResolvedValue(legacyRow);
  return {
    auth: {
      getUserIdentity: jest.fn().mockResolvedValue({ subject: "owner" }),
    },
    db: {
      query: jest.fn(() => ({ withIndex: jest.fn(() => ({ first })) })),
      patch: jest.fn(),
    },
  };
}

describe("user customization without traits", () => {
  it.each([getUserCustomization, getUserCustomizationForBackend])(
    "omits historical traits from customization responses",
    async (query) => {
      const result = await invoke(query, context(), {
        serviceKey: "synthetic",
        userId: "owner",
      });

      expect(result).toEqual({
        nickname: "Alex",
        occupation: "Pentester",
        additional_info: "Learning web security",
        include_notes: false,
        extra_usage_enabled: true,
        updated_at: 1,
      });
    },
  );

  it("retains service authentication for backend customization reads", async () => {
    await invoke(getUserCustomizationForBackend, context(), {
      serviceKey: "synthetic",
      userId: "owner",
    });
    expect(validateServiceKey).toHaveBeenCalledWith("synthetic");
  });

  it("allows profile updates on historical records without rewriting traits or other preferences", async () => {
    const ctx = context();
    await invoke(saveUserCustomization, ctx, { nickname: " Sam " });

    expect(ctx.db.patch).toHaveBeenCalledWith("customization", {
      nickname: "Sam",
      updated_at: expect.any(Number),
    });
  });
});
