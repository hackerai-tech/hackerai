import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "md" | "lg";
  variant?: "default" | "primary" | "secondary";
}

const Spinner = ({
  size = "md",
  variant = "default",
  className,
  ...props
}: SpinnerProps) => {
  const sizeClasses = {
    sm: "w-2 h-2",
    md: "w-4 h-4",
    lg: "w-6 h-6",
  };

  const variantClasses = {
    default: "bg-gray-600",
    primary: "bg-blue-600",
    secondary: "bg-gray-400",
  };

  return (
    <div
      className={cn("inline-flex items-center justify-center", className)}
      role="status"
      aria-label="Loading"
      {...props}
    >
      <div
        className={cn(
          "rounded-full animate-pulse",
          sizeClasses[size],
          variantClasses[variant],
        )}
      />
      <span className="sr-only">Loading...</span>
    </div>
  );
};

export default Spinner;
