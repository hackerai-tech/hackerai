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

describe("ConvexClientProvider auth recovery contracts", () => {
  it("disables AuthKit focus and visibility session probes", () => {
    expect(providerSource).toContain("onSessionExpired={false}");
    expect(providerSource).not.toContain("onSessionExpired={noop}");
  });

  it("hydrates AuthKit from server auth without serializing the access token", () => {
    expect(rootLayoutSource).toContain(
      "const { accessToken, ...initialAuth } = await withAuth();",
    );
    expect(rootLayoutSource).toContain(
      'if (!requestHeaders.has("x-workos-middleware"))',
    );
    expect(rootLayoutSource).toContain(
      "<ConvexClientProvider initialAuth={initialAuth}>",
    );
    expect(providerSource).toContain("initialAuth={initialAuth}");
  });
});
