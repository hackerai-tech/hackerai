"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useEffect, useRef } from "react";

export function useReferralClaim() {
  const { user } = useAuth();
  const claimedUserRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user?.id || claimedUserRef.current === user.id) return;
    claimedUserRef.current = user.id;

    fetch("/api/referrals/claim", {
      method: "POST",
      credentials: "include",
    }).catch(() => {
      // Best-effort: most sessions will not have a referral cookie.
    });
  }, [user?.id]);
}
