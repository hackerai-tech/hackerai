import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

export const useUpgrade = () => {
  const { user } = useAuth();
  const router = useRouter();
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeError, setUpgradeError] = useState("");

  const handleUpgrade = async (e?: React.MouseEvent<HTMLButtonElement | HTMLDivElement>) => {
    e?.preventDefault();

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

      const { error, url } = await res.json();

      if (!error && url) {
        return router.push(url);
      }

      setUpgradeError(`Error: ${error}`);
    } catch (err) {
      setUpgradeError("An unexpected error occurred");
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
