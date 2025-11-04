# Testing Guide

This document describes the testing setup and how to write and run tests for this project.

## Testing Stack

- **Jest**: Test runner and framework
- **React Testing Library**: Component testing
- **@testing-library/jest-dom**: Custom matchers for DOM assertions
- **@testing-library/user-event**: User interaction simulation

## Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode (useful during development)
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage

# Run tests in CI mode
pnpm test:ci
```

## Project Structure

Tests should be placed in `__tests__` directories adjacent to the code they test:

```
app/
  components/
    __tests__/
      Component.test.tsx
    Component.tsx
lib/
  utils/
    __tests__/
      utils.test.ts
    utils.ts
```

## Writing Tests

### Unit Tests

For utility functions and non-React code:

```typescript
import { describe, it, expect } from '@jest/globals';
import { myFunction } from '../myFunction';

describe('myFunction', () => {
  it('should return expected result', () => {
    expect(myFunction('input')).toBe('expected output');
  });
});
```

### Component Tests

For React components:

```typescript
import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MyComponent from '../MyComponent';

describe('MyComponent', () => {
  it('should render correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('should handle user interactions', async () => {
    const user = userEvent.setup();
    render(<MyComponent />);

    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Clicked')).toBeInTheDocument();
  });
});
```

## Configuration

- **jest.config.js**: Main Jest configuration
- **jest.setup.js**: Test environment setup (runs before each test file)

## Coverage

Coverage reports are generated in the `coverage/` directory when running `pnpm test:coverage`.

Current coverage thresholds are set to 0% to allow gradual adoption. These can be increased as test coverage improves.

## CI Integration

Tests run automatically on:
- All pushes to `main` branch
- All pull requests to `main` branch
- All pushes to feature branches (`feat/**`)

The CI workflow:
1. Installs dependencies
2. Runs linter
3. Runs tests with coverage
4. Uploads coverage reports to Codecov (if configured)
5. Comments coverage on pull requests

## Best Practices

1. **Test Behavior, Not Implementation**: Focus on testing what the code does, not how it does it
2. **Arrange-Act-Assert**: Structure tests with clear setup, execution, and verification phases
3. **Descriptive Test Names**: Use clear, descriptive test names that explain what is being tested
4. **Avoid Test Interdependence**: Each test should be independent and able to run in isolation
5. **Mock External Dependencies**: Mock APIs, databases, and other external services
6. **Use TypeScript**: Write tests in TypeScript for better type safety

## Mocking

Next.js router and navigation are automatically mocked in `jest.setup.js`. Add additional global mocks there as needed.

For module-specific mocks:

```typescript
jest.mock('../myModule', () => ({
  myFunction: jest.fn(() => 'mocked value'),
}));
```

## Resources

- [Jest Documentation](https://jestjs.io/)
- [React Testing Library Documentation](https://testing-library.com/react)
- [Testing Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
