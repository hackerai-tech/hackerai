"use client";

import React, { Component, ReactNode } from "react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { isExpectedConvexErrorCode } from "@/lib/utils/expected-convex-errors";

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
    // Handle ConvexError with toast
    if (error instanceof ConvexError) {
      const errorData = error.data as { code?: string; message?: string };
      if (!isExpectedConvexErrorCode(errorData?.code)) {
        console.error("ConvexErrorBoundary caught an error:", error, errorInfo);
      }

      // Note: CHAT_NOT_FOUND is now handled gracefully in the query itself
      // by returning empty results, so we don't need to handle it here
      if (errorData?.code === "CHAT_UNAUTHORIZED") {
        toast.error("Access denied", {
          description: "You don't have permission to access this task.",
        });
      } else {
        toast.error(
          errorData?.code === "CHAT_ACCESS_SUSPENDED"
            ? "Account suspended"
            : "Error",
          {
            description: errorData?.message || "An unexpected error occurred.",
          },
        );
      }
    } else {
      console.error("ConvexErrorBoundary caught an error:", error, errorInfo);
      toast.error("Something went wrong", {
        description: "Please try refreshing the page.",
      });
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  handleRefresh = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      const errorData =
        this.state.error instanceof ConvexError
          ? (this.state.error.data as { code?: string; message?: string })
          : null;
      const isSuspended = errorData?.code === "CHAT_ACCESS_SUSPENDED";
      return (
        this.props.fallback || (
          <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 min-h-0">
            <div className="w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col items-center space-y-8">
              <div className="text-center">
                <h1 className="text-2xl font-bold text-foreground mb-2">
                  {isSuspended ? "Account suspended" : "Something went wrong"}
                </h1>
                <p className="text-muted-foreground mb-6">
                  {isSuspended
                    ? errorData?.message ||
                      "Your account has been suspended. Contact support if you believe this is a mistake."
                    : "An unexpected error occurred. You can try again or start a new conversation."}
                </p>
                <div className="flex gap-3 justify-center">
                  {isSuspended ? (
                    <a
                      href="https://help.hackerai.co/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium"
                    >
                      Contact Support
                    </a>
                  ) : (
                    <>
                      <button
                        onClick={this.handleRetry}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium"
                      >
                        Try Again
                      </button>
                      <button
                        onClick={this.handleRefresh}
                        className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/90 transition-colors text-sm font-medium"
                      >
                        Refresh Page
                      </button>
                      <button
                        onClick={this.handleGoHome}
                        className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/90 transition-colors text-sm font-medium"
                      >
                        New Task
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
