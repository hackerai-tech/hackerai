"use client";

import React, { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";

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

interface MfaVerificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enrollmentData: EnrollmentData | null;
  onVerificationSuccess: () => void;
}

const MfaVerificationDialog = ({
  open,
  onOpenChange,
  enrollmentData,
  onVerificationSuccess,
}: MfaVerificationDialogProps) => {
  const [verificationCode, setVerificationCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [showManualCode, setShowManualCode] = useState(false);

  const handleVerifyCode = async () => {
    if (!enrollmentData?.challenge.id || !verificationCode.trim()) {
      toast.error("Please enter the verification code");
      return;
    }

    setVerifying(true);
    try {
      const response = await fetch("/api/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: enrollmentData.challenge.id,
          code: verificationCode,
        }),
      });

      const result = await response.json();

      if (response.ok && result.valid) {
        toast.success(
          "Multi-factor authentication setup completed successfully!",
        );
        handleClose();
        onVerificationSuccess();
      } else {
        toast.error(result.error || "Invalid verification code");
      }
    } catch (error) {
      toast.error("Failed to verify code");
    } finally {
      setVerifying(false);
    }
  };

  const handleClose = () => {
    setVerificationCode("");
    setShowManualCode(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-w-[95vw]">
        <DialogTitle>Secure your account</DialogTitle>
        <DialogDescription className="text-wrap break-words">
          {showManualCode
            ? "Manually enter the following code into your preferred authenticator app and then enter the provided one-time code below."
            : "Scan the QR Code below using your preferred authenticator app and then enter the provided one-time code below."}
        </DialogDescription>

        <div className="space-y-4">
          {/* QR Code or Manual Code */}
          {enrollmentData?.factor.qrCode && (
            <div className="flex flex-col items-center space-y-3">
              {!showManualCode ? (
                <>
                  {/* QR Code */}
                  <div className="p-3 bg-white rounded-lg">
                    <Image
                      src={enrollmentData.factor.qrCode}
                      alt="QR Code for 2FA setup"
                      className="w-32 h-32"
                      width={128}
                      height={128}
                      unoptimized
                    />
                  </div>

                  {/* Trouble scanning button */}
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setShowManualCode(true)}
                    className="text-sm text-muted-foreground hover:text-foreground underline"
                  >
                    Trouble scanning?
                  </Button>
                </>
              ) : (
                <>
                  {/* Manual code section */}
                  <div className="text-center p-4 rounded-lg space-y-3">
                    <code className="text-lg bg-muted px-4 py-3 rounded border block break-all select-all">
                      {enrollmentData.factor.secret}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (enrollmentData?.factor.secret) {
                          navigator.clipboard.writeText(
                            enrollmentData.factor.secret,
                          );
                        }
                      }}
                    >
                      Copy code
                    </Button>
                  </div>

                  {/* Switch back to QR button */}
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setShowManualCode(false)}
                    className="text-sm text-muted-foreground hover:text-foreground underline"
                  >
                    Scan QR code instead
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Verification Code Input */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Enter your one-time code*</Label>
              <Input
                id="code"
                type="text"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                maxLength={6}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleVerifyCode}
                disabled={verifying || verificationCode.length !== 6}
              >
                {verifying ? "Verifying..." : "Verify"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export { MfaVerificationDialog };
