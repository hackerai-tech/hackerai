"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";
import { useIsMobile } from "../../hooks/use-mobile";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const isMobile = useIsMobile();

  const getPositionProps = () => {
    if (isMobile) {
      return {
        position: "top-center" as const,
        offset: { top: 20 },
      };
    }
    return {
      position: "bottom-right" as const,
    };
  };

  const positionProps = getPositionProps();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position={positionProps.position}
      offset={positionProps.offset}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
