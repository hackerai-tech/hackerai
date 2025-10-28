import { Component, type ReactNode } from "react";
import { bundledLanguagesInfo } from "shiki/langs";

// Create a Set of all supported language IDs and aliases from Shiki
const SUPPORTED_LANGUAGES = new Set(
  bundledLanguagesInfo.flatMap((lang) => [lang.id, ...(lang.aliases || [])]),
);

export const isLanguageSupported = (lang: string | undefined): boolean => {
  if (!lang) return false;
  return SUPPORTED_LANGUAGES.has(lang.toLowerCase());
};

interface ShikiBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface ShikiBoundaryState {
  hasError: boolean;
}

export class ShikiErrorBoundary extends Component<
  ShikiBoundaryProps,
  ShikiBoundaryState
> {
  state: ShikiBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error) {
    console.log("[ShikiErrorBoundary] Caught error:", error.message);
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.log(
      "[ShikiErrorBoundary] Error caught and suppressed:",
      error.message,
    );
  }

  render() {
    const { hasError } = this.state;
    return hasError ? this.props.fallback : this.props.children;
  }
}
