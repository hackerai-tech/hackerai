// Create stable mock references for hooks
const mockMutation = jest.fn();
const mockAction = jest.fn();

export const useMutation = () => mockMutation;

export const useQuery = () => undefined;

export const useAction = () => mockAction;

type MockConvexAuthState = {
  isAuthenticated: boolean;
  isLoading: boolean;
};

const defaultConvexAuthState: MockConvexAuthState = {
  isAuthenticated: true,
  isLoading: false,
};

let convexAuthState = defaultConvexAuthState;

export const setMockConvexAuth = (next: Partial<MockConvexAuthState>): void => {
  convexAuthState = { ...convexAuthState, ...next };
};

export const resetMockConvexAuth = (): void => {
  convexAuthState = defaultConvexAuthState;
};

export const useConvexAuth = () => ({ ...convexAuthState });

// Create stable reference for paginated query results
const stablePaginatedResult = {
  results: [],
  status: "Exhausted" as const,
  loadMore: jest.fn(),
  isLoading: false,
};

export const usePaginatedQuery = () => stablePaginatedResult;

// Create stable convex client mock
const convexClientMock = {
  query: jest.fn(),
  mutation: jest.fn(),
  action: jest.fn(),
};

export const useConvex = () => convexClientMock;
