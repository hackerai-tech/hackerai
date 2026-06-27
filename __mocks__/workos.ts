export const useAuth = jest.fn(() => ({
  user: null,
  entitlements: [],
  isAuthenticated: false,
  signIn: jest.fn(),
  signOut: jest.fn(),
}));

export const useAccessToken = jest.fn(() => ({
  getAccessToken: jest.fn().mockResolvedValue("mock-access-token"),
  accessToken: "mock-access-token",
  refresh: jest.fn().mockResolvedValue("mock-access-token"),
}));
