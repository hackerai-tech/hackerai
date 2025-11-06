import React from "react";

// Simple mock for react-shiki
export const ShikiCode = ({ children }: { children?: React.ReactNode }) => {
  return <code data-testid="shiki-code">{children}</code>;
};

export default ShikiCode;
