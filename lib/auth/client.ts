/**
 * Client-safe auth utilities
 * This file can be safely imported on both client and server side
 */

/**
 * Auth modes supported by the application
 */
export type AuthMode = "workos" | "anonymous";

/**
 * Check if WorkOS authentication is enabled
 * Works on both server and client side
 */
export const isWorkOSEnabled = (): boolean =>
  process.env.NEXT_PUBLIC_AUTH_MODE === "workos";
