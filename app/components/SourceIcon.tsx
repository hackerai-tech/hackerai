"use client";

import { useState } from "react";
import Image from "next/image";
import { Globe } from "lucide-react";
import { sourceFaviconUrl } from "@/lib/utils/source-favicon";

export function SourceIcon({
  url,
  size = 16,
  className,
}: {
  url: string;
  size?: number;
  className?: string;
}) {
  const src = sourceFaviconUrl(url);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return src && src !== failedSrc ? (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      className={className}
      referrerPolicy="no-referrer"
      unoptimized
      onError={() => setFailedSrc(src)}
    />
  ) : (
    <Globe aria-hidden="true" size={size} className={className} />
  );
}
