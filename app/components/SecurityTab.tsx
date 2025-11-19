"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { MfaVerificationDialog } from "@/app/components/MfaVerificationDialog";
import { DeleteMfaFactorDialog } from "@/app/components/DeleteMfaFactorDialog";

interface MfaFactor {
  id: string;
  issuer?: string;
  user?: string;
  createdAt: string;
  updatedAt: string;
}

interface EnrollmentData {
  factor: {
    id: string;
    qrCode?: string;
    secret?: string;
    issuer?: string;
    user?: string;
  };
  challenge: {
    id: string;
    expiresAt: string;
  };
}

const SecurityTab = () => {
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [loading, setLoading] = useState(true);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [verificationDialog, setVerificationDialog] = useState<{
    open: boolean;
    data: EnrollmentData | null;
  }>({ open: false, data: null });
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    factorId: string | null;
  }>({ open: false, factorId: null });

  const fetchFactors = async () => {
    try {
      const response = await fetch("/api/mfa/factors");
      if (response.ok) {
        const data = await response.json();
        setFactors(data.factors);
        setMfaEnabled(data.factors.length > 0);
      } else {
        const error = await response.json().catch(() => ({}));
        toast.error(error?.error || "Failed to load security settings");
      }
    } catch (error) {
      console.error("Failed to fetch MFA factors:", error);
      toast.error("Failed to load security settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFactors();
  }, []);

  const handleEnrollStart = async () => {
    try {
      const response = await fetch("/api/mfa/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        const enrollmentData = await response.json();

        // Show QR code immediately
        setVerificationDialog({
          open: true,
          data: enrollmentData,
        });
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to enroll MFA factor");
      }
    } catch (error) {
      toast.error("Failed to enroll MFA factor");
    }
  };

  const handleVerificationSuccess = () => {
    setVerificationDialog({ open: false, data: null });
    fetchFactors(); // Refresh the factors list
  };

  const handleDeleteFactor = (factorId: string) => {
    setDeleteDialog({ open: true, factorId });
  };

  const handleMfaToggle = async (enabled: boolean) => {
    if (enabled && factors.length === 0) {
      // Enable MFA - start enrollment
      handleEnrollStart();
    } else if (!enabled && factors.length > 0) {
      // Disable MFA - remove all factors
      for (const factor of factors) {
        handleDeleteFactor(factor.id);
      }
    }
  };

  const handleLogout = async () => {
    try {
      // Redirect to logout route
      const { clientLogout } = await import("@/lib/utils/logout");
      clientLogout();
    } catch (error) {
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
        // Redirect to logout route to end current session
        const { clientLogout } = await import("@/lib/utils/logout");
        clientLogout();
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to log out of all devices");
      }
    } catch (error) {
      toast.error("Failed to log out of all devices");
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse">
          <div className="h-4 bg-muted rounded w-1/3 mb-4"></div>
          <div className="h-20 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Multi-factor Authentication Section */}
        <div className="flex items-center justify-between py-3 border-b">
          <div>
            <div className="font-medium text-base">
              Multi-factor authentication
            </div>
            {!mfaEnabled && (
              <div className="text-sm text-muted-foreground mt-1">
                Require an extra security challenge when logging in. If you are
                unable to pass this challenge, you will have the option to
                recover your account via email.
              </div>
            )}
          </div>
          <Switch
            data-testid="mfa-toggle"
            checked={mfaEnabled}
            onCheckedChange={handleMfaToggle}
            aria-label="Toggle multi-factor authentication"
          />
        </div>

        {/* Log out Section */}
        <div className="flex items-center justify-between py-3 border-b">
          <div>
            <div className="font-medium text-base">Log out of this device</div>
          </div>
          <Button data-testid="logout-button-device" variant="outline" size="sm" onClick={handleLogout}>
            Log out
          </Button>
        </div>

        {/* Log out of all devices Section */}
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

      {/* MFA Verification Dialog */}
      <MfaVerificationDialog
        open={verificationDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setVerificationDialog({ open: false, data: null });
          }
        }}
        enrollmentData={verificationDialog.data}
        onVerificationSuccess={handleVerificationSuccess}
      />

      <DeleteMfaFactorDialog
        open={deleteDialog.open}
        onOpenChange={(open) => {
          if (!open) setDeleteDialog({ open: false, factorId: null });
        }}
        factorId={deleteDialog.factorId}
        onDeleted={() => {
          setDeleteDialog({ open: false, factorId: null });
          fetchFactors();
        }}
      />
    </>
  );
};

export { SecurityTab };
