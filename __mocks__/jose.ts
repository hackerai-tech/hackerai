import fs from "node:fs";
import path from "node:path";

// Simple mock for jose JWT library
export const compactDecrypt = jest.fn();
export const CompactEncrypt = jest.fn();
export const jwtVerify = jest.fn();
export const SignJWT = jest.fn();

// Claim decoding is not mocked: tests exercise real account matching. The
// app's jose is ESM-only, so load the AuthKit SDK's CommonJS jose by path
// (Jest maps the `jose` specifier itself to this file).
let realDecodeJwt: ((token: string) => Record<string, unknown>) | undefined;
export const decodeJwt = (token: string) => {
  if (!realDecodeJwt) {
    const authkit = fs.realpathSync(
      path.join(process.cwd(), "node_modules/@workos-inc/authkit-nextjs"),
    );
    const sdkJose = fs.realpathSync(path.join(authkit, "../../jose"));
    realDecodeJwt = jest.requireActual<{
      decodeJwt: (token: string) => Record<string, unknown>;
    }>(path.join(sdkJose, "dist/node/cjs/index.js")).decodeJwt;
  }
  return realDecodeJwt(token);
};

const mockJose = {
  compactDecrypt,
  CompactEncrypt,
  decodeJwt,
  jwtVerify,
  SignJWT,
};

export default mockJose;
