import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface DotsSpinnerProps extends HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "md" | "lg";
  variant?: "default" | "primary" | "secondary";
}

const DotsSpinner = ({
  size = "md",
  variant = "default",
  className,
  ...props
}: DotsSpinnerProps) => {
  const sizeClasses = {
    sm: "w-1 h-1",
    md: "w-2 h-2",
    lg: "w-3 h-3",
  };

  const gapClasses = {
    sm: "gap-0.5",
    md: "gap-1",
    lg: "gap-1.5",
  };

  const variantClasses = {
    default: "bg-gray-600",
    primary: "bg-blue-600",
    secondary: "bg-gray-400",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center",
        gapClasses[size],
        className,
      )}
      role="status"
      aria-label="Loading"
      {...props}
    >
      <div
        className={cn(
          "rounded-full animate-bounce",
          sizeClasses[size],
          variantClasses[variant],
        )}
        style={{ animationDelay: "0ms" }}
      />
      <div
        className={cn(
          "rounded-full animate-bounce",
          sizeClasses[size],
          variantClasses[variant],
        )}
        style={{ animationDelay: "150ms" }}
      />
      <div
        className={cn(
          "rounded-full animate-bounce",
          sizeClasses[size],
          variantClasses[variant],
        )}
        style={{ animationDelay: "300ms" }}
      />
      <span className="sr-only">Loading...</span>
    </div>
  );
};

export default DotsSpinner;
