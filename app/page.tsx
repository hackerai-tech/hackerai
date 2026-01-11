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
import MigratePentestgptDialog from "./components/MigratePentestgptDialog";
import { usePricingDialog } from "./hooks/usePricingDialog";
import { useGlobalState } from "./contexts/GlobalState";
import { usePentestgptMigration } from "./hooks/usePentestgptMigration";
import { useTauri, openInBrowser } from "./hooks/useTauri";

// Simple unauthenticated content that redirects to login on message send
const UnauthenticatedContent = () => {
  const { isTauri } = useTauri();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isTauri) {
      const opened = await openInBrowser(
        `${window.location.origin}/desktop-login`,
      );
      if (opened) {
        return;
      }
    }
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
                onSendNow={() => {}}
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
  const {
    subscription,
    teamPricingDialogOpen,
    setTeamPricingDialogOpen,
    teamWelcomeDialogOpen,
    setTeamWelcomeDialogOpen,
    migrateFromPentestgptDialogOpen,
    setMigrateFromPentestgptDialogOpen,
  } = useGlobalState();
  const { showPricing, handleClosePricing } = usePricingDialog(subscription);

  const { isMigrating, migrate } = usePentestgptMigration();
  const searchParams =
    typeof window !== "undefined" ? window.location.search : "";
  const { initialSeats, initialPlan } = React.useMemo(() => {
    if (typeof window === "undefined") {
      return { initialSeats: 5, initialPlan: "monthly" as const };
    }
    const urlParams = new URLSearchParams(searchParams);
    const urlSeats = urlParams.get("numSeats");
    const urlPlan = urlParams.get("selectedPlan");

    let seats = 5;
    if (urlSeats) {
      const parsed = parseInt(urlSeats, 10);
      if (!isNaN(parsed) && parsed >= 1) {
        seats = parsed;
      }
    }

    const plan = (urlPlan === "yearly" ? "yearly" : "monthly") as
      | "monthly"
      | "yearly";

    return { initialSeats: seats, initialPlan: plan };
  }, [searchParams]);

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
      <MigratePentestgptDialog
        open={migrateFromPentestgptDialogOpen}
        onOpenChange={setMigrateFromPentestgptDialogOpen}
        isMigrating={isMigrating}
        onConfirm={migrate}
      />
    </>
  );
}
