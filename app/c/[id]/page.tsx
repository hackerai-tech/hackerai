"use client";

import { Chat } from "../../components/chat";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import Loading from "@/components/ui/loading";
import { use, useEffect } from "react";

export default function Page(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const chatId = params.id;

  // Add logging to track which auth state is active
  useEffect(() => {
    console.log("📄 [Page] Chat page render:", {
      timestamp: new Date().toISOString(),
      chatId,
      route: `/c/${chatId}`
    });
  }, [chatId]);

  return (
    <>
      <AuthLoading>
        <div className="h-screen bg-background flex flex-col overflow-hidden">
          <div className="flex-1 flex items-center justify-center">
            <AuthLoadingWithLogging />
          </div>
        </div>
      </AuthLoading>

      <Authenticated>
        <AuthenticatedWithLogging chatId={chatId} />
      </Authenticated>

      <Unauthenticated>
        <div className="h-screen bg-background flex flex-col overflow-hidden">
          <div className="flex-1 flex items-center justify-center">
            <UnauthenticatedWithLogging />
          </div>
        </div>
      </Unauthenticated>
    </>
  );
}

// Component to log when AuthLoading is active
function AuthLoadingWithLogging() {
  useEffect(() => {
    console.log("⏳ [Page] AuthLoading component mounted - Convex determining auth state");
    
    // Set a timeout to detect if we're stuck in AuthLoading
    const timeout = setTimeout(() => {
      console.warn("🚨 [Page] AuthLoading stuck for 15+ seconds - possible infinite loading!");
    }, 15000);
    
    return () => {
      console.log("✅ [Page] AuthLoading component unmounted - auth state determined");
      clearTimeout(timeout);
    };
  }, []);
  
  return <Loading />;
}

// Component to log when user is authenticated
function AuthenticatedWithLogging({ chatId }: { chatId: string }) {
  useEffect(() => {
    console.log("🔓 [Page] Authenticated component mounted - user is authenticated");
    return () => {
      console.log("🔒 [Page] Authenticated component unmounted");
    };
  }, []);
  
  return <Chat key={chatId} id={chatId} />;
}

// Component to log when user is unauthenticated
function UnauthenticatedWithLogging() {
  useEffect(() => {
    console.log("❌ [Page] Unauthenticated component mounted - user not authenticated");
    
    // Set a timeout to detect if we're stuck in Unauthenticated
    const timeout = setTimeout(() => {
      console.warn("🚨 [Page] Unauthenticated stuck for 15+ seconds - should redirect to login!");
    }, 15000);
    
    return () => {
      console.log("✅ [Page] Unauthenticated component unmounted");
      clearTimeout(timeout);
    };
  }, []);
  
  return <Loading />;
}
