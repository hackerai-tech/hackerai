/** @jest-environment-options {"customExportConditions": ["node", "node-addons"]} */

jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("@trigger.dev/sdk", () => ({ defineConfig: (config) => config }));

const config = require("../trigger.config").default;
const packageJson = require("../package.json");

describe("Trigger runtime packages", () => {
  const extension = config.build.extensions.find(
    (candidate) => candidate.name === "additionalPackages",
  );

  test("installs the pinned dynamic download dependency in the deployment layer", async () => {
    const addLayer = jest.fn();

    // Run the actual extension: a declared root dependency alone does not
    // ensure createRequire can resolve it from an isolated deployed bundle.
    await extension.onBuildStart({
      target: "deploy",
      resolvePath: async (name) => require.resolve(name),
      logger: { debug: jest.fn(), warn: jest.fn() },
      addLayer,
    });

    expect(addLayer).toHaveBeenCalledWith({
      id: "additionalPackages",
      dependencies: {
        "node-pty": expect.any(String),
        sharp: expect.any(String),
        undici: packageJson.dependencies.undici,
      },
    });
  });

  test("does not install deployment packages in development", async () => {
    const addLayer = jest.fn();
    await extension.onBuildStart({ target: "dev", addLayer });
    expect(addLayer).not.toHaveBeenCalled();
  });
});
