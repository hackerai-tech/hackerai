"use client";

import React from "react";
import { useConvexAuth } from "convex/react";
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
import { upsertDraft } from "@/lib/utils/client-storage";
import Loading from "@/components/ui/loading";
import { useHasAuthenticatedBefore } from "../hooks/useHasAuthenticatedBefore";
import { PUBLIC_POSITIONING } from "@/lib/marketing/positioning";

const LOGIN_TYPING_PREFIX = "Ask HackerAI to ";
const LOGIN_TYPING_TAILS = [
  "map this target and find the next move…",
  "trace this auth flaw through the codebase…",
  "turn this request into a working exploit…",
  "run the right tools against this scope…",
  "validate the impact and kill false positives…",
  "turn this evidence into a clean report…",
];

// Simple unauthenticated content that redirects to signup on message send
const UnauthenticatedContent = () => {
  const { input } = useGlobalState();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      upsertDraft("new", input);
    }
    navigateToAuth("/signup", { preferSignInForReturningUser: true });
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
        navigateToAuth("/signup?intent=pricing", {
          preferSignInForReturningUser: true,
        });
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
          <div className="mb-5 flex max-w-3xl flex-col items-center px-4 text-center md:mb-7">
            <p className="text-muted-foreground mb-3 font-mono text-xs font-medium uppercase tracking-[0.2em]">
              {PUBLIC_POSITIONING.eyebrow}
            </p>
            <h1 className="text-foreground mb-3 text-4xl font-bold text-balance md:text-5xl">
              {PUBLIC_POSITIONING.headline}
            </h1>
            <p className="text-muted-foreground max-w-2xl text-lg leading-relaxed text-pretty md:text-xl">
              {PUBLIC_POSITIONING.description}
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
              restoreDraftAttachments={false}
            />
          </div>
          <p className="text-muted-foreground mt-4 max-w-2xl px-4 text-center text-xs leading-relaxed text-pretty md:text-sm">
            {PUBLIC_POSITIONING.audience}
          </p>
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
  const { showPricing, handleClosePricing, pricingContext } =
    usePricingDialog(subscription);
  const { isLoading, isAuthenticated } = useConvexAuth();
  const hasAuthHint = useHasAuthenticatedBefore();

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
      "monthly" | "yearly";

    return { initialSeats: seats, initialPlan: plan };
  }, [searchParams]);

  if (isAuthenticated || (isLoading && hasAuthHint)) {
    return (
      <>
        <AuthenticatedContent />
        <ExtraUsagePurchaseToast />
        <PricingDialog
          isOpen={showPricing}
          onClose={handleClosePricing}
          context={pricingContext}
        />
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

  if (isLoading) {
    return (
      <div className="h-full bg-background flex flex-col overflow-hidden">
        <div className="flex-1 flex items-center justify-center">
          <Loading />
        </div>
      </div>
    );
  }

  return <UnauthenticatedContent />;
}
