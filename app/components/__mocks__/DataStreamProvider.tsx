import { ReactNode } from "react";

// Create stable mock reference
const mockSetIsAutoResuming = jest.fn();

export const useDataStream = () => ({
  setIsAutoResuming: mockSetIsAutoResuming,
});

export const DataStreamProvider = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};
