import nextConfig from "eslint-config-next";

export default [
  ...nextConfig,
  {
    ignores: [".claude/**", ".cursor/**", ".github/**"],
  },
];
