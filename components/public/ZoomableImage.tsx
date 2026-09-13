"use client";

import { useState } from "react";
import Image, { type ImageProps } from "next/image";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type ZoomableImageProps = Pick<
  ImageProps,
  "src" | "alt" | "width" | "height" | "priority"
> & {
  /** Classes for the clickable frame around the inline image. */
  frameClassName?: string;
};

/** Inline image that opens full-size in a dialog on click or tap. */
export function ZoomableImage({
  src,
  alt,
  width,
  height,
  priority,
  frameClassName,
}: ZoomableImageProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View larger: ${alt}`}
        className={cn(
          "block w-full cursor-zoom-in overflow-hidden text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          frameClassName,
        )}
      >
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          priority={priority}
          className="h-auto w-full"
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          overlayClassName="bg-black/85"
          className="max-w-[calc(100%-1rem)] border-0 bg-transparent p-0 shadow-none sm:max-w-6xl [&_[data-slot=dialog-close]]:top-2 [&_[data-slot=dialog-close]]:right-2 [&_[data-slot=dialog-close]]:rounded-full [&_[data-slot=dialog-close]]:bg-background [&_[data-slot=dialog-close]]:p-2 [&_[data-slot=dialog-close]]:opacity-100 [&_[data-slot=dialog-close]_svg]:size-5"
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <Image
            src={src}
            alt={alt}
            width={width}
            height={height}
            className="mx-auto h-auto max-h-[90dvh] w-auto max-w-full rounded-lg object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
