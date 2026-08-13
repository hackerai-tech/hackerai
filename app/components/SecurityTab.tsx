"use client";

import React, { useCallback } from "react";
import { useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { UserSecurity } from "@workos-inc/widgets/user-security";
import { WorkOsWidgets } from "@workos-inc/widgets/workos-widgets";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const SecurityTab = () => {
  const { getAccessToken } = useAccessToken();
  const getWidgetAccessToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error("Unable to load security settings");
    }
    return token;
  }, [getAccessToken]);

  const handleLogout = async () => {
    try {
      const { clientLogout } = await import("@/lib/utils/logout");
      clientLogout();
    } catch {
      toast.error("Failed to log out");
    }
  };

  const handleLogoutAll = async () => {
    try {
      const response = await fetch("/api/logout-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        const data = await response.json();
        toast.success(
          `Logged out of ${data.revokedSessions} devices successfully`,
        );
        const { clientLogout } = await import("@/lib/utils/logout");
        clientLogout();
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to log out of all devices");
      }
    } catch {
      toast.error("Failed to log out of all devices");
    }
  };

  return (
    <div className="space-y-6">
      <div data-testid="workos-user-security">
        <WorkOsWidgets
          theme={{
            appearance: "dark",
            accentColor: "gray",
            grayColor: "slate",
            hasBackground: false,
            fontFamily: "var(--font-geist-sans)",
          }}
        >
          <UserSecurity authToken={getWidgetAccessToken} />
        </WorkOsWidgets>
      </div>

      <div className="border-t">
        <div className="flex items-center justify-between py-3 border-b">
          <div className="font-medium text-base">Log out of this device</div>
          <Button
            data-testid="logout-button-device"
            variant="outline"
            size="sm"
            onClick={handleLogout}
          >
            Log out
          </Button>
        </div>

        <div className="flex items-start justify-between py-3">
          <div className="flex-1 pr-4">
            <div className="font-medium text-base">Log out of all devices</div>
            <div className="text-sm text-muted-foreground mt-1">
              Log out of all active sessions across all devices, including your
              current session. It may take up to 10 minutes for other devices to
              be logged out.
            </div>
          </div>
          <Button
            data-testid="logout-button-all"
            variant="destructive"
            size="sm"
            onClick={handleLogoutAll}
            className="bg-red-600 hover:bg-red-700 text-white shrink-0"
          >
            Log out all
          </Button>
        </div>
      </div>
    </div>
  );
};

export { SecurityTab };
