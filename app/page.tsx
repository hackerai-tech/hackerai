"use client";

import React from "react";
import { Authenticated, Unauthenticated } from "convex/react";
import { ChatInput } from "./components/ChatInput";
import Header from "./components/Header";
import Footer from "./components/Footer";
import { Chat } from "./components/chat";
import PricingDialog from "./components/PricingDialog";
import TeamPricingDialog from "./components/TeamPricingDialog";
import { TeamWelcomeDialog } from "./components/TeamDialogs";
import { usePricingDialog } from "./hooks/usePricingDialog";
import { useGlobalState } from "./contexts/GlobalState";

// Simple unauthenticated content that redirects to login on message send
const UnauthenticatedContent = () => {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Preserve input draft for later; redirect to login
    window.location.href = "/login";
  };

  const handleStop = () => {
    // No-op for unauthenticated users
  };

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <div className="flex-shrink-0">
        <Header />
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {/* Centered content area */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
          <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
            {/* Centered title */}
            <div className="text-center">
              <h1 className="text-3xl font-bold text-foreground mb-2">
                HackerAI
              </h1>
              <p className="text-muted-foreground">Your AI pentest assistant</p>
            </div>

            {/* Centered input */}
            <div className="w-full">
              <ChatInput
                onSubmit={handleSubmit}
                onStop={handleStop}
                status="ready"
                isCentered={true}
                isNewChat={true}
                clearDraftOnSubmit={false}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0">
          <Footer />
        </div>
      </div>
    </div>
  );
};

// Authenticated content that shows chat (UUID generated internally)
const AuthenticatedContent = () => {
  return <Chat autoResume={false} />;
};

// Main page component with Convex authentication
export default function Page() {
  const { showPricing, handleClosePricing } = usePricingDialog();
  const {
    teamPricingDialogOpen,
    setTeamPricingDialogOpen,
    teamWelcomeDialogOpen,
    setTeamWelcomeDialogOpen,
  } = useGlobalState();

  // Read initial values from URL for team pricing dialog
  const { initialSeats, initialPlan } = React.useMemo(() => {
    if (typeof window === "undefined") {
      return { initialSeats: 5, initialPlan: "monthly" as const };
    }
    const urlParams = new URLSearchParams(window.location.search);
    const urlSeats = urlParams.get("numSeats");
    const urlPlan = urlParams.get("selectedPlan");

    const seats = urlSeats ? parseInt(urlSeats) : 5;
    const plan = (urlPlan === "yearly" ? "yearly" : "monthly") as
      | "monthly"
      | "yearly";

    return { initialSeats: seats, initialPlan: plan };
  }, []);

  return (
    <>
      <Authenticated>
        <AuthenticatedContent />
      </Authenticated>
      <Unauthenticated>
        <UnauthenticatedContent />
      </Unauthenticated>
      <PricingDialog isOpen={showPricing} onClose={handleClosePricing} />
      <TeamPricingDialog
        isOpen={teamPricingDialogOpen}
        onClose={() => setTeamPricingDialogOpen(false)}
        initialSeats={initialSeats}
        initialPlan={initialPlan}
      />
      <TeamWelcomeDialog
        open={teamWelcomeDialogOpen}
        onOpenChange={setTeamWelcomeDialogOpen}
      />
    </>
  );
}
