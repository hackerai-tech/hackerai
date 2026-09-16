import { render, waitFor } from "@testing-library/react";

jest.mock("@intercom/messenger-js-sdk", () => ({
  __esModule: true,
  default: jest.fn(),
  boot: jest.fn(),
  shutdown: jest.fn(),
  update: jest.fn(),
}));

jest.mock("@/lib/intercom/client", () => ({
  shutdownIntercomSession: jest.fn(),
}));

const intercom = jest.requireMock<typeof import("@intercom/messenger-js-sdk")>(
  "@intercom/messenger-js-sdk",
);
const { shutdownIntercomSession } = jest.requireMock<
  typeof import("@/lib/intercom/client")
>("@/lib/intercom/client");
const { IntercomMessenger } =
  require("../IntercomMessenger") as typeof import("../IntercomMessenger");

const initialize = intercom.default as jest.Mock;
const boot = intercom.boot as jest.Mock;
const shutdown = intercom.shutdown as jest.Mock;
const update = intercom.update as jest.Mock;
const mockShutdownIntercomSession = shutdownIntercomSession as jest.Mock;

const firstIdentity = {
  appId: "wjc8uwt3",
  apiBase: "https://api-iam.intercom.io",
  userId: "user_123",
  userJwt: "first.jwt",
};

describe("IntercomMessenger", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("boots hidden with only signed identity data and safely changes users", async () => {
    const { rerender } = render(<IntercomMessenger identity={firstIdentity} />);

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledWith({
      app_id: "wjc8uwt3",
      api_base: "https://api-iam.intercom.io",
      intercom_user_jwt: "first.jwt",
      hide_default_launcher: true,
      hide_notifications: true,
    });
    expect(initialize.mock.calls[0]?.[0]).not.toHaveProperty("email");
    expect(initialize.mock.calls[0]?.[0]).not.toHaveProperty("user_id");

    rerender(
      <IntercomMessenger
        identity={{ ...firstIdentity, userJwt: "refreshed.jwt" }}
      />,
    );
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ intercom_user_jwt: "refreshed.jwt" }),
    );

    rerender(
      <IntercomMessenger
        identity={{
          ...firstIdentity,
          userId: "user_456",
          userJwt: "second.jwt",
        }}
      />,
    );
    await waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      boot.mock.invocationCallOrder[0]!,
    );

    rerender(<IntercomMessenger identity={null} />);
    expect(mockShutdownIntercomSession).toHaveBeenCalledTimes(1);
  });
});
