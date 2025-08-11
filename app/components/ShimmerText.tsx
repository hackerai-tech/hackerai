import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface ShimmerTextProps extends HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
  duration?: string;
  fromColor?: string;
  viaColor?: string;
  toColor?: string;
}

export const ShimmerText = ({
  children,
  duration = "2s",
  fromColor = "from-muted-foreground",
  viaColor = "via-foreground",
  toColor = "to-muted-foreground",
  className,
  ...props
}: ShimmerTextProps) => {
  return (
    <span
      className={cn(
        "inline-block bg-gradient-to-r bg-clip-text text-transparent",
        fromColor,
        viaColor,
        toColor,
        className,
      )}
      style={{
        animation: `shimmer ${duration} linear infinite`,
        backgroundSize: "200% 100%",
      }}
      {...props}
    >
      {children}
    </span>
  );
};
