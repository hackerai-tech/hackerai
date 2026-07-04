import React, { ReactNode } from "react";
import { GlobalStateProvider } from "@/app/contexts/GlobalState";
import { AgentApprovalProvider } from "@/app/contexts/AgentApprovalContext";
import { DataStreamProvider } from "./DataStreamProvider";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Test wrapper with all required providers for component testing
 */
export const TestWrapper = ({ children }: { children: ReactNode }) => {
  return (
    <GlobalStateProvider>
      <AgentApprovalProvider>
        <DataStreamProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </DataStreamProvider>
      </AgentApprovalProvider>
    </GlobalStateProvider>
  );
};
