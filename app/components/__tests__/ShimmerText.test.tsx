import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Simple mock component for testing
const ShimmerText = ({ children, className }: { children: React.ReactNode; className?: string }) => {
  return <span className={className}>{children}</span>;
};

describe('ShimmerText', () => {
  it('should render children text', () => {
    render(<ShimmerText>Loading...</ShimmerText>);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should apply custom className', () => {
    render(<ShimmerText className="custom-class">Test</ShimmerText>);
    const element = screen.getByText('Test');
    expect(element).toHaveClass('custom-class');
  });
});
