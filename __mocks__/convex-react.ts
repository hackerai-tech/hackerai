export const useMutation = () => jest.fn();

export const useQuery = () => undefined;

export const useAction = () => jest.fn();

// Create stable reference for paginated query results
const stablePaginatedResult = {
  results: [],
  status: 'Exhausted' as const,
  loadMore: jest.fn(),
  isLoading: false,
};

export const usePaginatedQuery = () => stablePaginatedResult;

export const useConvex = () => ({
  query: jest.fn(),
  mutation: jest.fn(),
  action: jest.fn(),
});
