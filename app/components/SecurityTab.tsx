"use client";

import React, { useCallback } from "react";
import { useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { UserSecurity } from "@workos-inc/widgets/user-security";
import { WorkOsWidgets } from "@workos-inc/widgets/workos-widgets";
import { LogOut, Monitor } from "lucide-react";
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
          className="hackerai-security-widget"
          style={{ blockSize: "auto", minBlockSize: "auto" }}
          theme={{
            appearance: "inherit",
            accentColor: "gray",
            grayColor: "gray",
            hasBackground: false,
            panelBackground: "solid",
            fontFamily: "var(--font-geist-sans)",
          }}
        >
          <UserSecurity authToken={getWidgetAccessToken} />
        </WorkOsWidgets>
      </div>

      <div
        data-testid="security-session-actions"
        className="overflow-hidden rounded-lg border bg-card text-card-foreground"
      >
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b p-4">
          <div
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-md border bg-muted/50"
          >
            <Monitor className="size-4" />
          </div>
          <div className="min-w-0 text-sm font-semibold">
            Log out of this device
          </div>
          <Button
            data-testid="logout-button-device"
            variant="outline"
            size="sm"
            onClick={handleLogout}
          >
            Log out
          </Button>
        </div>

        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <div
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-md border bg-muted/50"
          >
            <LogOut className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">Log out of all devices</div>
            <div className="mt-1 text-sm text-muted-foreground">
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
            className="col-start-2 w-fit shrink-0 bg-red-600 text-white hover:bg-red-700 sm:col-start-3 sm:row-start-1"
          >
            Log out all
          </Button>
        </div>
      </div>
    </div>
  );
};

export { SecurityTab };
