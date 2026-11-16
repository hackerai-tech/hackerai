"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import Loading from "@/components/ui/loading";
import { SchedulesPage } from "@/app/components/schedules/SchedulesPage";
export default function Page() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const router = useRouter();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/");
  }, [isLoading, isAuthenticated, router]);
  return isAuthenticated ? (
    <SchedulesPage />
  ) : (
    <div className="flex h-full items-center justify-center">
      <Loading />
    </div>
  );
}
