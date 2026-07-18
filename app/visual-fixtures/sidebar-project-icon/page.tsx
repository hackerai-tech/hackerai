import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SidebarProjectIconPreview } from "./SidebarProjectIconPreview";
import { canViewSidebarProjectIconPreview } from "./preview-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sidebar Project Icon Preview",
  robots: { index: false, follow: false },
};

export default function SidebarProjectIconPreviewPage() {
  if (!canViewSidebarProjectIconPreview()) notFound();

  return <SidebarProjectIconPreview />;
}
