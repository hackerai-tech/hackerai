// Simple mock for jose JWT library
export const compactDecrypt = jest.fn();
export const CompactEncrypt = jest.fn();
export const jwtVerify = jest.fn();
export const SignJWT = jest.fn();

export default {
  compactDecrypt,
  CompactEncrypt,
  jwtVerify,
  SignJWT,
};
