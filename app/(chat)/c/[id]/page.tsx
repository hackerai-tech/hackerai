"use client";

import { Chat } from "../../../components/chat";
import { useConvexAuth } from "convex/react";
import Loading from "@/components/ui/loading";
import PricingDialog from "../../../components/PricingDialog";
import { usePricingDialog } from "../../../hooks/usePricingDialog";
import { useGlobalState } from "../../../contexts/GlobalState";
import { hasAuthenticatedBefore } from "@/lib/utils/client-storage";
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Page(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const chatId = params.id;
  const router = useRouter();
  const { subscription } = useGlobalState();
  const { showPricing, handleClosePricing, pricingContext } =
    usePricingDialog(subscription);
  const { isLoading, isAuthenticated } = useConvexAuth();

  const shouldRenderChat =
    isAuthenticated || (isLoading && hasAuthenticatedBefore());

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/");
    }
  }, [isAuthenticated, isLoading, router]);

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
