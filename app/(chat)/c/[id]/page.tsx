"use client";

import { Chat } from "../../../components/chat";
import { useConvexAuth } from "convex/react";
import Loading from "@/components/ui/loading";
import PricingDialog from "../../../components/PricingDialog";
import { usePricingDialog } from "../../../hooks/usePricingDialog";
import { useGlobalState } from "../../../contexts/GlobalState";
import { hasAuthenticatedBefore } from "@/lib/utils/client-storage";
import { use } from "react";

export default function Page(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const chatId = params.id;
  const { subscription } = useGlobalState();
  const { showPricing, handleClosePricing, pricingContext } =
    usePricingDialog(subscription);
  const { isLoading, isAuthenticated } = useConvexAuth();

  const shouldRenderChat =
    isAuthenticated || (isLoading && hasAuthenticatedBefore());

  return (
    <>
      {shouldRenderChat ? (
        <Chat key={chatId} autoResume={true} />
      ) : (
        <div className="h-full bg-background flex flex-col overflow-hidden">
          <div className="flex-1 flex items-center justify-center">
            <Loading />
          </div>
        </div>
      )}

      <PricingDialog
        isOpen={showPricing}
        onClose={handleClosePricing}
        context={pricingContext}
      />
    </>
  );
}
