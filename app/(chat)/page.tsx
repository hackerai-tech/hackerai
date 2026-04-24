"use client";

import React from "react";
import { Authenticated, Unauthenticated } from "convex/react";
import { ChatInput } from "../components/ChatInput";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { Chat } from "../components/chat";
import PricingDialog from "../components/PricingDialog";
import TeamPricingDialog from "../components/TeamPricingDialog";
import { TeamWelcomeDialog } from "../components/TeamDialogs";
import MigratePentestgptDialog from "../components/MigratePentestgptDialog";
import { ExtraUsagePurchaseToast } from "../components/extra-usage";
import { usePricingDialog } from "../hooks/usePricingDialog";
import { useGlobalState } from "../contexts/GlobalState";
import { usePentestgptMigration } from "../hooks/usePentestgptMigration";
import { navigateToAuth } from "../hooks/useTauri";
import { useTypingAnimation } from "../hooks/useTypingAnimation";

const LOGIN_TYPING_PREFIX = "Ask HackerAI to ";
const LOGIN_TYPING_TAILS = [
  "find vulnerabilities in...",
  "audit the security of...",
  "test the defenses of...",
  "review the code of...",
  "write a pentest report for...",
  "hunt for bugs in...",
];

// Simple unauthenticated content that redirects to login on message send
const UnauthenticatedContent = () => {
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    navigateToAuth("/login");
  };

  const animatedTail = useTypingAnimation({
    phrases: LOGIN_TYPING_TAILS,
    enabled: true,
  });
  const animatedPlaceholder = `${LOGIN_TYPING_PREFIX}${animatedTail}`;

  const handleStop = () => {
    // No-op for unauthenticated users
  };

  React.useEffect(() => {
    const checkHash = () => {
      if (
        window.location.hash === "#pricing" ||
        window.location.hash === "#team-pricing-seat-selection"
      ) {
        navigateToAuth("/login");
      }
    };
    checkHash();
    window.addEventListener("hashchange", checkHash);
    return () => window.removeEventListener("hashchange", checkHash);
  }, []);

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <div className="flex-shrink-0">
        <Header />
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {/* Centered content area */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-[15vh] pb-[18vh] min-h-0">
          {/* Title */}
          <div className="mb-4 flex flex-col items-center px-4 text-center md:mb-6">
            <h1 className="text-4xl font-bold text-foreground mb-2 md:text-5xl">
              What will you hack today?
            </h1>
            <p className="text-muted-foreground text-lg leading-tight md:text-xl">
              Find and fix vulnerabilities by chatting with AI.
            </p>
          </div>

          {/* Input */}
          <div className="w-full max-w-3xl">
            <ChatInput
              onSubmit={handleSubmit}
              onStop={handleStop}
              onSendNow={() => {}}
              status="ready"
              isCentered={true}
              isNewChat={true}
              clearDraftOnSubmit={false}
              placeholder={animatedPlaceholder}
              autoFocus={false}
            />
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
        <ExtraUsagePurchaseToast />
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
      </Authenticated>
      <Unauthenticated>
        <UnauthenticatedContent />
      </Unauthenticated>
    </>
  );
}
