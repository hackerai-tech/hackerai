/**
 * E2E Test Constants
 * Centralized configuration for all timeout values and test data
 */

export const TIMEOUTS = {
  // Short timeouts for fast operations
  SHORT: 15000, // 15s - UI element visibility, quick checks

  // Medium timeouts for normal operations
  MEDIUM: 30000, // 30s - Message rendering, file uploads

  // Long timeouts for slow operations
  LONG: 60000, // 60s - AI response streaming

  // Extra long timeouts for agent operations
  AGENT: 90000, // 90s - Agent mode operations
  AGENT_LONG: 120000, // 120s - Complex agent operations (image processing)

  // Special timeouts
  STOP_BUTTON_CHECK: 5000, // 1s - Quick check if streaming is active
} as const;

export const TEST_DATA = {
  // Test resource paths
  RESOURCES: {
    IMAGE: "e2e/resource/image.png",
    TEXT_FILE: "e2e/resource/secret.txt",
    PDF_FILE: "e2e/resource/secret.pdf",
  },

  // Expected content in test files
  SECRETS: {
    TEXT: "bazinga",
    PDF: "hippo",
    IMAGE_CONTENT: "duck",
  },

  // Common test messages
  MESSAGES: {
    SIMPLE: "Say hello in one word",
    COUNT: "Count from 1 to 5",
    LONG_STORY: "Write a very long story about a duck",
    MATH_SIMPLE: "What is 2+2?",
    MATH_NEXT: "What is 3+3?",
  },
} as const;
