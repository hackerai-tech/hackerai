const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testEnvironment: "jest-environment-jsdom",
  moduleNameMapper: {
    "^jose$": "<rootDir>/__mocks__/jose.ts",
    "^@workos-inc/node$": "<rootDir>/__mocks__/workos-node.ts",
    "^@workos-inc/authkit-nextjs$": "<rootDir>/__mocks__/workos-authkit.ts",
    "^@workos-inc/authkit-nextjs/components$": "<rootDir>/__mocks__/workos.ts",
    "^stripe$": "<rootDir>/__mocks__/stripe.ts",
    "^@/(.*)$": "<rootDir>/$1",
    "^convex/react$": "<rootDir>/__mocks__/convex-react.ts",
    "^uuid$": "<rootDir>/__mocks__/uuid.ts",
    "^react-hotkeys-hook$": "<rootDir>/__mocks__/react-hotkeys-hook.ts",
    "^react-markdown$": "<rootDir>/__mocks__/react-markdown.tsx",
    "^streamdown$": "<rootDir>/__mocks__/streamdown.tsx",
    "^react-shiki$": "<rootDir>/__mocks__/react-shiki.tsx",
    "^shiki/langs$": "<rootDir>/__mocks__/shiki.ts",
    "^shiki$": "<rootDir>/__mocks__/shiki.ts",
    "^use-stick-to-bottom$": "<rootDir>/__mocks__/use-stick-to-bottom.ts",
    "^@aws-sdk/client-s3$": "<rootDir>/__mocks__/@aws-sdk/client-s3.ts",
    "^@aws-sdk/s3-request-presigner$":
      "<rootDir>/__mocks__/@aws-sdk/s3-request-presigner.ts",
    "^@upstash/redis$": "<rootDir>/__mocks__/@upstash/redis.ts",
    "^@upstash/ratelimit$": "<rootDir>/__mocks__/@upstash/ratelimit.ts",
    "^convex/browser$": "<rootDir>/__mocks__/convex/browser.ts",
    "^@trigger\\.dev/react-hooks$":
      "<rootDir>/__mocks__/trigger-dev-react-hooks.ts",
    "^@trigger\\.dev/sdk/v3$": "<rootDir>/__mocks__/trigger-dev-sdk.ts",
  },
  transformIgnorePatterns: [
    "node_modules/(?!(uuid|@ai-sdk|ai|convex|react-hotkeys-hook|react-markdown|streamdown|remark-.*|unified|bail|is-plain-obj|trough|vfile|unist-.*|mdast-.*|micromark.*|decode-named-character-reference|character-entities|escape-string-regexp|markdown-table|property-information|hast-.*|space-separated-tokens|comma-separated-tokens|zwitch|html-void-elements|ccount|devlop|@trigger.dev|superjson)/)",
  ],
  testMatch: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/", "/e2e/", "/dist/"],
  collectCoverageFrom: [
    "app/**/*.{js,jsx,ts,tsx}",
    "convex/**/*.{js,jsx,ts,tsx}",
    "!**/*.d.ts",
    "!**/node_modules/**",
    "!**/.next/**",
    "!**/coverage/**",
    "!**/dist/**",
  ],
  coverageReporters: ["text", "json-summary", "lcov"],
  coverageThreshold: {
    global: {
      statements: 0,
      branches: 0,
      functions: 0,
      lines: 0,
    },
  },
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig);
