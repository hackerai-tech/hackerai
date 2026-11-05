import { signOut } from "@workos-inc/authkit-nextjs";
import { GET } from "../route";

jest.mock("@workos-inc/authkit-nextjs", () => ({ signOut: jest.fn() }));

const originalEnv = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    VERCEL_ENV: "preview",
    VERCEL_URL: "deployment.vercel.app",
    VERCEL_BRANCH_URL: "branch.vercel.app",
  };
});
afterEach(() => {
  process.env = originalEnv;
});

it.each(["deployment.vercel.app", "branch.vercel.app"])(
  "returns Preview logout to the current trusted host %s",
  async (host) => {
    await GET({ url: `https://${host}/logout` } as Request);
    expect(signOut).toHaveBeenCalledWith({ returnTo: `https://${host}/` });
  },
);

it("does not use an untrusted request host as the logout destination", async () => {
  await GET({ url: "https://attacker.example/logout" } as Request);
  expect(signOut).toHaveBeenCalledWith({
    returnTo: "https://deployment.vercel.app/",
  });
});

it.each(["production", "development"])(
  "preserves configured WorkOS logout behavior in %s",
  async (environment) => {
    process.env.VERCEL_ENV = environment;
    await GET({ url: "https://app.example/logout" } as Request);
    expect(signOut).toHaveBeenCalledWith();
  },
);

it("preserves configured logout when Preview has no trusted deployment host", async () => {
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_BRANCH_URL;
  await GET({ url: "https://attacker.example/logout" } as Request);
  expect(signOut).toHaveBeenCalledWith();
});
