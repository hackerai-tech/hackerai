export const useAuth = () => ({
  user: null,
  entitlements: [],
  isAuthenticated: false,
  signIn: jest.fn(),
  signOut: jest.fn(),
});

export const useAccessToken = () => ({
  getAccessToken: jest.fn().mockResolvedValue("mock-access-token"),
  accessToken: "mock-access-token",
  refresh: jest.fn().mockResolvedValue("mock-access-token"),
});
