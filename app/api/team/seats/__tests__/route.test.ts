import path from "node:path";
import { PATCH, POST } from "../route";
import { workos } from "../../../workos";
import { stripe } from "../../../stripe";
import { requireAdminOrg } from "../../team-auth";
import { hasActiveSuspensionForUser } from "@/lib/suspensions";

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

jest.mock("../../team-auth", () => ({
  requireAdminOrg: jest.fn(),
}));

jest.mock("@/lib/suspensions", () => ({
  hasActiveSuspensionForUser: jest.fn(),
}));

jest.mock("../../../workos", () => ({
  workos: {
    organizations: { getOrganization: jest.fn() },
    userManagement: {
      listOrganizationMemberships: jest.fn(),
      listInvitations: jest.fn(),
    },
  },
}));

jest.mock("../../../stripe", () => ({
  stripe: {
    subscriptions: { list: jest.fn(), update: jest.fn() },
    prices: { retrieve: jest.fn() },
    invoices: { createPreview: jest.fn() },
  },
}));

// Jest maps @workos-inc/node to an app mock; use the installed SDK paginator so
// fixtures follow its real page traversal (and its `limit` short-circuit).
const { AutoPaginatable } = jest.requireActual(
  path.join(process.cwd(), "node_modules/@workos-inc/node/lib/index.cjs"),
) as typeof import("@workos-inc/node");

/** Serve WorkOS list pages; `failure` rejects the fetch of that page index. */
function workosList<T>(pages: T[][], failure?: { page: number; error: Error }) {
  const fetchPage = async ({ after }: { after?: string | null }) => {
    const page = after ? Number(after) : 0;
    if (failure?.page === page) throw failure.error;
    return {
      object: "list" as const,
      data: pages[page],
      listMetadata: {
        after: page + 1 < pages.length ? String(page + 1) : null,
      },
    };
  };
  return async (options?: object) =>
    new AutoPaginatable(await fetchPage({}), fetchPage, options);
}

const mockRequireAdminOrg = requireAdminOrg as jest.MockedFunction<
  typeof requireAdminOrg
>;
const mockHasActiveSuspension =
  hasActiveSuspensionForUser as jest.MockedFunction<
    typeof hasActiveSuspensionForUser
  >;
const mockGetOrganization = workos.organizations
  .getOrganization as jest.MockedFunction<
  typeof workos.organizations.getOrganization
>;
const mockListMemberships = workos.userManagement
  .listOrganizationMemberships as jest.MockedFunction<
  typeof workos.userManagement.listOrganizationMemberships
>;
const mockListInvitations = workos.userManagement
  .listInvitations as jest.MockedFunction<
  typeof workos.userManagement.listInvitations
>;
const mockListSubscriptions = stripe.subscriptions.list as jest.MockedFunction<
  typeof stripe.subscriptions.list
>;
const mockUpdateSubscription = stripe.subscriptions
  .update as jest.MockedFunction<typeof stripe.subscriptions.update>;
const mockRetrievePrice = stripe.prices.retrieve as jest.MockedFunction<
  typeof stripe.prices.retrieve
>;
const mockCreatePreview = stripe.invoices.createPreview as jest.MockedFunction<
  typeof stripe.invoices.createPreview
>;

const request = (quantity: number) =>
  ({ json: async () => ({ quantity }) }) as never;

const member = (id: string) => ({ id, userId: `user_${id}` });
const invitation = (id: string, state: string) => ({ id, state });

// Six purchased seats; three active members and two pending invitations, with
// part of each list (and non-pending invitations) only on the second page.
const SUBSCRIBED_SEATS = 6;
const membersAcrossPages = [[member("m1"), member("m2")], [member("m3")]];
const invitationsAcrossPages = [
  [invitation("i1", "pending"), invitation("i_accepted", "accepted")],
  [invitation("i2", "pending"), invitation("i_revoked", "revoked")],
];

describe("/api/team/seats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminOrg.mockResolvedValue({
      ok: true,
      userId: "user_admin",
      organizationId: "org_team",
      membership: { role: { slug: "admin" } },
    } as never);
    mockHasActiveSuspension.mockResolvedValue(false);
    mockGetOrganization.mockResolvedValue({
      id: "org_team",
      stripeCustomerId: "cus_team",
    } as never);
    mockListSubscriptions.mockResolvedValue({
      data: [
        {
          id: "sub_team",
          default_payment_method: null,
          items: {
            data: [
              {
                id: "si_team",
                quantity: SUBSCRIBED_SEATS,
                price: { id: "price_team" },
              },
            ],
          },
        },
      ],
    } as never);
    mockListMemberships.mockImplementation(
      workosList(membersAcrossPages) as never,
    );
    mockListInvitations.mockImplementation(
      workosList(invitationsAcrossPages) as never,
    );
    mockRetrievePrice.mockResolvedValue({
      unit_amount: 2000,
      recurring: { interval: "month" },
    } as never);
    mockCreatePreview.mockResolvedValue({
      amount_due: 0,
      total: -2000,
    } as never);
    mockUpdateSubscription.mockResolvedValue({ latest_invoice: null } as never);
  });

  it("POST rejects a preview below members and invitations on later pages", async () => {
    const response = await POST(request(4));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Cannot reduce seats below current usage",
      details:
        "You have 5 seats in use. Remove members or revoke invites before reducing seats.",
    });
    expect(mockCreatePreview).not.toHaveBeenCalled();
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("PATCH rejects a reduction below members and invitations on later pages", async () => {
    const response = await PATCH(request(4));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Cannot reduce seats below current usage",
      details:
        "You have 3 members and 2 pending invites (5 total). Remove members or revoke invites before reducing seats.",
    });
    expect(mockUpdateSubscription).not.toHaveBeenCalled();
  });

  it("PATCH reduces seats to exactly the paginated active usage", async () => {
    const response = await PATCH(request(5));

    expect(response.status).toBe(200);
    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1);
    expect(mockUpdateSubscription).toHaveBeenCalledWith(
      "sub_team",
      expect.objectContaining({
        items: [{ id: "si_team", quantity: 5 }],
        proration_behavior: "create_prorations",
      }),
    );
  });

  it.each([
    { list: "membership", failMembers: true },
    { list: "invitation", failMembers: false },
  ])(
    "PATCH does not change the subscription when a later $list page fails",
    async ({ failMembers }) => {
      const failure = { page: 1, error: new Error("WorkOS page unavailable") };
      if (failMembers) {
        mockListMemberships.mockImplementation(
          workosList(membersAcrossPages, failure) as never,
        );
      } else {
        mockListInvitations.mockImplementation(
          workosList(invitationsAcrossPages, failure) as never,
        );
      }
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        const response = await PATCH(request(4));

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
          error: "WorkOS page unavailable",
        });
        expect(mockUpdateSubscription).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});
