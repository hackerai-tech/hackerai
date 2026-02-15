"use client";

import { ChatContent } from "@/app/components/chat";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import Loading from "@/components/ui/loading";
import PricingDialog from "@/app/components/PricingDialog";
import { usePricingDialog } from "@/app/hooks/usePricingDialog";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { use } from "react";

export default function Page(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const chatId = params.id;
  const { subscription } = useGlobalState();
  const { showPricing, handleClosePricing } = usePricingDialog(subscription);

  return (
    <>
      <AuthLoading>
        <div className="h-full bg-background flex flex-col overflow-hidden">
          <div className="flex-1 flex items-center justify-center">
            <Loading />
          </div>
        </div>
      </AuthLoading>

      <Authenticated>
        <ChatContent chatId={chatId} autoResume={true} />
      </Authenticated>

      <Unauthenticated>
        <div className="h-full bg-background flex flex-col overflow-hidden">
          <div className="flex-1 flex items-center justify-center">
            <Loading />
          </div>
        </div>
      </Unauthenticated>

      <PricingDialog isOpen={showPricing} onClose={handleClosePricing} />
    </>
  );
}
