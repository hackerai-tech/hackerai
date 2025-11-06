import React, { ReactNode } from "react";
import { GlobalStateProvider } from "@/app/contexts/GlobalState";
import { DataStreamProvider } from "./DataStreamProvider";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Test wrapper with all required providers for component testing
 */
export const TestWrapper = ({ children }: { children: ReactNode }) => {
  return (
    <GlobalStateProvider>
      <DataStreamProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </DataStreamProvider>
    </GlobalStateProvider>
  );
};
