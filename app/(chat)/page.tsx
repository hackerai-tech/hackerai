import type { Metadata } from "next";

import { canonicalMetadata } from "@/lib/seo/site";
import HomePageClient from "./HomePageClient";

export const metadata: Metadata = {
  ...canonicalMetadata("/"),
};

export default function Page() {
  return <HomePageClient />;
}
