import React from "react";

// Simple mock for streamdown
export const Streamdown = ({ children }: { children: string }) => {
  return <div data-testid="streamdown">{children}</div>;
};

export default Streamdown;
