// Simple mock for @workos-inc/authkit-nextjs
export const getUser = jest.fn().mockResolvedValue({
  id: "test-user-id",
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
});

export const getSignInUrl = jest.fn().mockResolvedValue("https://sign-in.url");
export const getSignUpUrl = jest.fn().mockResolvedValue("https://sign-up.url");
export const signOut = jest.fn().mockResolvedValue(undefined);

const mockWorkosAuthkit = {
  getUser,
  getSignInUrl,
  getSignUpUrl,
  signOut,
};

export default mockWorkosAuthkit;
