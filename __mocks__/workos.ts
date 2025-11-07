export const useAuth = () => ({
  user: null,
  entitlements: [],
  isAuthenticated: false,
  signIn: jest.fn(),
  signOut: jest.fn(),
});
