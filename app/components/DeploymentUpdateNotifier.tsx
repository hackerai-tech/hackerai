"use client";

import { useDeploymentUpdate } from "@/app/hooks/useDeploymentUpdate";

/**
 * Renders nothing; runs useDeploymentUpdate to poll for new deployments
 * and show an "Update Available" toast with a refresh button when detected.
 */
export const DeploymentUpdateNotifier = () => {
  useDeploymentUpdate();
  return null;
};
