import React from "react";

export const useIsCodeFenceIncomplete = () => false;

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
