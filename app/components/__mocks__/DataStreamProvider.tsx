import { ReactNode } from "react";

// Create stable mock references
const mockSetDataStream = jest.fn();
const mockSetIsAutoResuming = jest.fn();
const mockSetIsAutoContinuing = jest.fn();
const mockSetAutoContinueCount = jest.fn();

export const useDataStream = () => ({
  dataStream: [],
  isAutoResuming: false,
  isAutoContinuing: false,
  autoContinueCount: 0,
  setDataStream: mockSetDataStream,
  setIsAutoResuming: mockSetIsAutoResuming,
  setIsAutoContinuing: mockSetIsAutoContinuing,
  setAutoContinueCount: mockSetAutoContinueCount,
});

export const useDataStreamState = () => ({
  dataStream: [],
  isAutoResuming: false,
  isAutoContinuing: false,
  autoContinueCount: 0,
});

export const useDataStreamDispatch = () => ({
  setDataStream: mockSetDataStream,
  setIsAutoResuming: mockSetIsAutoResuming,
  setIsAutoContinuing: mockSetIsAutoContinuing,
  setAutoContinueCount: mockSetAutoContinueCount,
});

export const DataStreamProvider = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};
