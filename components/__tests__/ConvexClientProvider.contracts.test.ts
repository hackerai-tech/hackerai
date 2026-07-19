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
    expect(authkitPatchSource).toContain("errorText.includes('invalid_grant')");
    expect(authkitPatchSource).toContain("throw error;");
    expect(authkitPatchSource).toContain(
      "recoverEndedSession(() => refreshSession({ organizationId })",
    );
    expect(authkitPatchSource).toContain(
      "recoverEndedSession(() => switchToOrganization(organizationId, options)",
    );
    expect(authkitPatchSource).toContain(
      "recoverEndedSession(() => withAuth(), { user: null })",
    );
    expect(authkitPatchSource).toContain(
      "if (isEndedSessionRefreshError(error))",
    );
    expect(authkitPatchSource).toContain("return { accessToken: undefined };");
  });
});
