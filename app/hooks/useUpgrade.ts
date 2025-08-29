import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

export const useUpgrade = () => {
  const { user } = useAuth();
  const router = useRouter();
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeError, setUpgradeError] = useState("");

  const handleUpgrade = async (
    e?: React.MouseEvent<HTMLButtonElement | HTMLDivElement>,
  ) => {
    e?.preventDefault();

    // Prevent duplicate submits
    if (upgradeLoading) {
      return;
    }

    if (!user) {
      setUpgradeError("Please sign in to upgrade");
      return;
    }

    setUpgradeLoading(true);
    setUpgradeError("");

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      // Check if response is ok, if not throw error with status and body
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const { error, url } = await res.json();

      if (url) {
        return router.push(url);
      }

      if (error) {
        setUpgradeError(`Error: ${error}`);
      } else {
        setUpgradeError("Unknown error creating checkout session");
      }
    } catch (err) {
      // Surface real error messages when err is an Error
      if (err instanceof Error) {
        setUpgradeError(err.message);
      } else {
        setUpgradeError("An unexpected error occurred");
      }
    } finally {
      setUpgradeLoading(false);
    }
  };

  return {
    upgradeLoading,
    upgradeError,
    handleUpgrade,
    setUpgradeError,
  };
};
