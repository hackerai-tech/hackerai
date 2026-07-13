import fs from "fs";
import path from "path";

const providerSource = fs.readFileSync(
  path.resolve(__dirname, "../ConvexClientProvider.tsx"),
  "utf8",
);

describe("ConvexClientProvider auth recovery contracts", () => {
  it("disables AuthKit focus and visibility session probes", () => {
    expect(providerSource).toContain(
      "<AuthKitProvider onSessionExpired={false}>",
    );
    expect(providerSource).not.toContain("onSessionExpired={noop}");
  });
});
