// Simple mock for jose JWT library
export const compactDecrypt = jest.fn();
export const CompactEncrypt = jest.fn();
export const jwtVerify = jest.fn();
export const SignJWT = jest.fn();

const mockJose = {
  compactDecrypt,
  CompactEncrypt,
  jwtVerify,
  SignJWT,
};

export default mockJose;
