/**
 * Jest configuration for Convex backend tests
 * Runs in pure Node environment WITHOUT Next.js to avoid memory issues
 */

module.exports = {
  testEnvironment: "node",
  testMatch: [
    "**/convex/__tests__/**/*.test.ts",
    "**/lib/__tests__/**/*.test.ts",
  ],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^gpt-tokenizer$": "<rootDir>/__mocks__/gpt-tokenizer.ts",
    "^pdfjs-serverless$": "<rootDir>/__mocks__/pdfjs-serverless.ts",
    "^mammoth$": "<rootDir>/__mocks__/mammoth.ts",
    "^word-extractor$": "<rootDir>/__mocks__/word-extractor.ts",
    "^isbinaryfile$": "<rootDir>/__mocks__/isbinaryfile.ts",
    "^@langchain/community/document_loaders/fs/csv$":
      "<rootDir>/__mocks__/@langchain/community/document_loaders/fs/csv.ts",
  },
  collectCoverageFrom: [
    "convex/**/*.{js,ts}",
    "lib/**/*.{js,ts}",
    "!**/*.d.ts",
    "!**/node_modules/**",
    "!**/__tests__/**",
    "!**/coverage/**",
  ],
  coverageReporters: ["text", "json-summary", "lcov"],
};
