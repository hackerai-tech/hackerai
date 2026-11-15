import React from "react";

export const useIsCodeFenceIncomplete = () => false;

// The stub ignores plugins; real Markdown runs in scripts/markdown tests.
export const defaultRemarkPlugins = {};

// Simple mock for streamdown
export const Streamdown = ({
  children,
  isAnimating = false,
}: {
  children: string;
  isAnimating?: boolean;
}) => {
  return (
    <div data-animating={String(isAnimating)} data-testid="streamdown">
      {children}
    </div>
  );
};

export default Streamdown;
