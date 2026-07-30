import fs from "fs";
import path from "path";

const providerSource = fs.readFileSync(
  path.resolve(__dirname, "../ConvexClientProvider.tsx"),
  "utf8",
);
const rootLayoutSource = fs.readFileSync(
  path.resolve(__dirname, "../../app/layout.tsx"),
  "utf8",
);
const authkitPatchSource = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../patches/@workos-inc__authkit-nextjs@4.2.0.patch",
  ),
  "utf8",
);
const expectedAuthErrorSource = fs.readFileSync(
  path.resolve(__dirname, "../../lib/auth/expected-auth-errors.ts"),
  "utf8",
);

describe("ConvexClientProvider auth recovery contracts", () => {
  it("disables AuthKit focus and visibility session probes", () => {
    expect(providerSource).toContain("onSessionExpired={false}");
    expect(providerSource).not.toContain("onSessionExpired={noop}");
  });

  it("hydrates AuthKit from server auth without serializing the access token", () => {
    expect(rootLayoutSource).toContain(
      "return resolveClientInitialAuth(withAuth);",
    );
    expect(rootLayoutSource).toContain(
      'if (!requestHeaders.has("x-workos-middleware"))',
    );
    expect(rootLayoutSource).toContain(
      "<ConvexClientProvider initialAuth={initialAuth}>",
    );
    expect(providerSource).toContain("initialAuth={initialAuth}");
  });

  it("recovers exact ended sessions at automatic AuthKit action boundaries", () => {
    expect(authkitPatchSource).toContain(
      "const isEndedSessionRefreshError = (value",
    );
    for (const contractText of [
      "invalid_grant",
      "session has already ended",
      "session ended due to inactivity",
    ]) {
      expect(authkitPatchSource).toContain(contractText);
      expect(expectedAuthErrorSource).toContain(contractText);
    }
    expect(authkitPatchSource).toContain("throw error;");
    expect(authkitPatchSource).toContain(
      "recoverEndedSession(() => refreshSession({ organizationId })",
    );
    expect(authkitPatchSource).toContain(
      "recoverEndedSession(() => switchToOrganization(organizationId, options)",
    );
    expect(authkitPatchSource).toMatch(
      /const \{ user, organizationId: sessionOrganizationId \} = await recoverEndedSession[\s\S]{0,160}\(\) => withAuth\(\)/,
    );
    expect(authkitPatchSource).toMatch(
      /export const getAuthAction[\s\S]{0,700}const auth = await recoverEndedSession\(\(\) => withAuth\(\), \{ user: null \}/,
    );
    expect(authkitPatchSource).toMatch(
      /export async function getAccessTokenAction[\s\S]{0,350}recoverEndedSession\(\(\) => withAuth\(\), \{ user: null \}[\s\S]{0,100}return auth\.accessToken/,
    );
    expect(authkitPatchSource).toContain(
      "if (isEndedSessionRefreshError(error))",
    );
    expect(authkitPatchSource).toContain("return { accessToken: undefined };");
  });
});
