import React from "react";

// Simple mock for react-markdown
const ReactMarkdown = ({ children }: { children: string }) => {
  return <div data-testid="react-markdown">{children}</div>;
};

export default ReactMarkdown;
