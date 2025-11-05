import { ReactNode } from 'react';

export const useDataStream = () => ({
  setIsAutoResuming: jest.fn(),
});

export const DataStreamProvider = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};
