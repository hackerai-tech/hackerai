"use client";

import React, { Component, ReactNode } from "react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ConvexErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ConvexErrorBoundary caught an error:", error, errorInfo);

    // Handle ConvexError with toast
    if (error instanceof ConvexError) {
      const errorData = error.data as { code?: string; message?: string };

      // Note: CHAT_NOT_FOUND is now handled gracefully in the query itself
      // by returning empty results, so we don't need to handle it here
      if (errorData?.code === "CHAT_UNAUTHORIZED") {
        toast.error("Access denied", {
          description: "You don't have permission to access this chat.",
        });
      } else {
        toast.error("Error", {
          description: errorData?.message || "An unexpected error occurred.",
        });
      }
    } else {
      toast.error("Something went wrong", {
        description: "Please try refreshing the page.",
      });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
            <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
              <div className="text-center">
                <h1 className="text-2xl font-bold text-foreground mb-2">
                  Something went wrong
                </h1>
                <p className="text-muted-foreground">
                  Please try refreshing the page or go back to the home page.
                </p>
              </div>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
