// Simple mock for stripe
const Stripe = jest.fn().mockImplementation(() => ({
  checkout: {
    sessions: {
      create: jest.fn(),
      retrieve: jest.fn(),
    },
  },
  billingPortal: {
    sessions: {
      create: jest.fn(),
    },
  },
  customers: {
    create: jest.fn(),
    retrieve: jest.fn(),
    update: jest.fn(),
  },
  subscriptions: {
    create: jest.fn(),
    retrieve: jest.fn(),
    update: jest.fn(),
    cancel: jest.fn(),
  },
}));

// Use the SDK's real error classes so recovery tests exercise instanceof checks.
const StripeWithErrors = Object.assign(Stripe, {
  errors: jest.requireActual("../node_modules/stripe/cjs/Error.js"),
});

export default StripeWithErrors;
