"use client";

import { Authenticated, Unauthenticated } from "convex/react";
import { ChatInput } from "./components/ChatInput";
import Header from "./components/Header";
import Footer from "./components/Footer";
import { useGlobalState } from "./contexts/GlobalState";
import { Chat } from "./components/chat";

// Simple unauthenticated content that redirects to login on message send
const UnauthenticatedContent = () => {
  const { clearInput } = useGlobalState();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Clear the input and redirect to login
    clearInput();
    window.location.href = "/login";
  };

  const handleStop = () => {
    // No-op for unauthenticated users
  };

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
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
  return <Chat />;
};

// Main page component with Convex authentication
export default function Page() {
  return (
    <>
      <Authenticated>
        <AuthenticatedContent />
      </Authenticated>
      <Unauthenticated>
        <UnauthenticatedContent />
      </Unauthenticated>
    </>
  );
}
