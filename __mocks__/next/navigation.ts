// Manual mock for next/navigation
export const useRouter = jest.fn(() => ({
  push: jest.fn(),
  replace: jest.fn(),
  refresh: jest.fn(),
  prefetch: jest.fn(),
  back: jest.fn(),
  forward: jest.fn(),
  pathname: "/",
  query: {},
  asPath: "/",
}));

export const usePathname = jest.fn(() => "/");
export const useSearchParams = jest.fn(() => new URLSearchParams());
export const useParams = jest.fn(() => ({}));
export const notFound = jest.fn();
export const redirect = jest.fn();
export const useSelectedLayoutSegment = jest.fn();
export const useSelectedLayoutSegments = jest.fn();
