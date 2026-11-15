"use client";

import React from "react";
import { useConvexAuth } from "convex/react";
import { ChatInput } from "../components/ChatInput";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { Chat } from "../components/chat";
import PricingDialog from "../components/PricingDialog";
import { TeamWelcomeDialog } from "../components/TeamDialogs";
import MigratePentestgptDialog from "../components/MigratePentestgptDialog";
import { ExtraUsagePurchaseToast } from "../components/extra-usage";
import { usePricingDialog } from "../hooks/usePricingDialog";
import { useGlobalState } from "../contexts/GlobalState";
import { useComposerInput } from "../contexts/ComposerState";
import { usePentestgptMigration } from "../hooks/usePentestgptMigration";
import { navigateToAuth } from "../hooks/useTauri";
import { useTypingAnimation } from "../hooks/useTypingAnimation";
import { upsertDraft } from "@/lib/utils/client-storage";
import Loading from "@/components/ui/loading";
import { useHasAuthenticatedBefore } from "../hooks/useHasAuthenticatedBefore";

const LOGIN_TYPING_PREFIX = "Ask HackerAI to ";
const LOGIN_TYPING_TAILS = [
  "find vulnerabilities in...",
  "audit the security of...",
  "test the defenses of...",
  "review the code of...",
  "write a pentest report for...",
  "hunt for bugs in...",
];

// Simple unauthenticated content that redirects to signup on message send
const UnauthenticatedContent = () => {
  const input = useComposerInput();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      upsertDraft("new", input);
    }
    navigateToAuth("/signup", { preferSignInForReturningUser: true });
  };

  const handleStop = () => {
    // No-op for unauthenticated users
  };

  const animatedTail = useTypingAnimation({
    phrases: LOGIN_TYPING_TAILS,
    enabled: true,
  });
  const animatedPlaceholder = `${LOGIN_TYPING_PREFIX}${animatedTail}`;

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex-shrink-0">
        <Header publicRedesign />
      </div>

      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
        {/* Centered content area */}
        <div className="flex flex-1 flex-col items-center justify-center-safe px-2 py-6 sm:px-6 sm:py-10 [@media(max-height:500px)]:py-2">
          {/* Title */}
          <div className="mb-7 flex flex-col items-center px-4 text-center md:mb-9">
            <h1 className="mb-4 max-w-[900px] text-[clamp(2.65rem,5vw,4.5rem)] font-semibold leading-[1.05] tracking-[-0.055em] text-foreground [@media(max-height:500px)]:text-3xl">
              What will you hack today?
            </h1>
            <p className="text-lg leading-snug text-muted-foreground md:text-xl [@media(max-height:500px)]:text-base">
              Find and fix vulnerabilities by working with AI.
            </p>
          </div>

          {/* Input */}
          <div className="w-full max-w-[800px]">
            <ChatInput
              onSubmit={handleSubmit}
              onStop={handleStop}
              onSendNow={() => {}}
              status="ready"
              isCentered={true}
              isNewChat={true}
              clearDraftOnSubmit={false}
              placeholder={animatedPlaceholder}
              landingAppearance
              autoFocus={false}
              restoreDraftAttachments={false}
              offlineProtection={false}
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
export default function HomePageClient() {
  const {
    subscription,
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
