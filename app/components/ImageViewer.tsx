import Image from "next/image";
import { Download, ZoomIn, ZoomOut } from "lucide-react";
import { useState, useEffect, useRef } from "react";

interface ImageViewerProps {
  isOpen: boolean;
  onClose: () => void;
  imageSrc: string;
  imageAlt: string;
  fileName?: string;
}

export const ImageViewer = ({
  isOpen,
  onClose,
  imageSrc,
  imageAlt,
  fileName,
}: ImageViewerProps) => {
  const [isImageLoading, setIsImageLoading] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const imageFrameRef = useRef<HTMLDivElement>(null);
  const didDragRef = useRef(false);
  const dragStartRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);

  // Reset loading state when imageSrc changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsImageLoading(true);
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }, [imageSrc]);

  // Focus the dialog when it opens
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen]);

  // Handle Escape key press
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Don't render if not open or no valid image source
  if (!isOpen || !imageSrc || imageSrc.trim() === "") {
    return null;
  }

  const handleImageLoad = () => {
    setIsImageLoading(false);
  };

  const handleImageError = () => {
    setIsImageLoading(false);
  };

  const handleClose = () => {
    onClose();
  };

  const setZoomAtPoint = (
    nextZoom: number,
    point?: { x: number; y: number },
  ) => {
    setZoom((currentZoom) => {
      const clampedZoom = Math.min(300, Math.max(25, nextZoom));

      if (!point || clampedZoom <= 100) {
        setPan({ x: 0, y: 0 });
        return clampedZoom;
      }

      const oldScale = currentZoom / 100;
      const newScale = clampedZoom / 100;
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;

      setPan((currentPan) => ({
        x:
          point.x -
          centerX -
          (newScale / oldScale) * (point.x - centerX - currentPan.x),
        y:
          point.y -
          centerY -
          (newScale / oldScale) * (point.y - centerY - currentPan.y),
      }));

      return clampedZoom;
    });
  };

  const handleDownload = async () => {
    const downloadName =
      fileName ||
      imageAlt
        .trim()
        .replace(/[^\w.\- ]+/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 80) ||
      "image";

    try {
      const response = await fetch(imageSrc);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(imageSrc, "_blank", "noopener,noreferrer");
    }
  };

  const handleZoomOut = () => {
    setZoomAtPoint(zoom - 25);
  };

  const handleZoomIn = () => {
    setZoomAtPoint(zoom + 25, {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const direction = e.deltaY > 0 ? -25 : 25;
    setZoomAtPoint(zoom + direction, { x: e.clientX, y: e.clientY });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 100 || e.button !== 0) return;

    dragStartRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const dragStart = dragStartRef.current;
    if (!dragStart) return;

    if (
      Math.abs(e.clientX - dragStart.x) > 3 ||
      Math.abs(e.clientY - dragStart.y) > 3
    ) {
      didDragRef.current = true;
    }

    setPan({
      x: dragStart.panX + e.clientX - dragStart.x,
      y: dragStart.panY + e.clientY - dragStart.y,
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current?.pointerId === e.pointerId) {
      dragStartRef.current = null;
      setIsDragging(false);
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }

    if (e.target === e.currentTarget) {
      const imageBounds = imageFrameRef.current?.getBoundingClientRect();
      if (
        imageBounds &&
        e.clientX >= imageBounds.left &&
        e.clientX <= imageBounds.right &&
        e.clientY >= imageBounds.top &&
        e.clientY <= imageBounds.bottom
      ) {
        return;
      }

      handleClose();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    setZoomAtPoint(zoom >= 200 ? 100 : 200, {
      x: e.clientX,
      y: e.clientY,
    });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div
      data-state="open"
      className="radix-state-open:animate-show fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/90 dark:bg-black/80"
      style={{ pointerEvents: "auto" }}
      onClick={handleBackdropClick}
      tabIndex={-1}
      data-testid="image-zoom-modal"
    >
      <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-black/65 py-1 pl-1 pr-3 text-white shadow-2xl backdrop-blur-2xl">
        <button
          type="button"
          className="flex size-7 cursor-pointer items-center justify-center rounded transition-colors hover:bg-white/10"
          onClick={handleDownload}
          aria-label="Download image"
        >
          <Download className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="h-4 w-px bg-white/25" />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={handleZoomOut}
            disabled={zoom <= 25}
            aria-label="Zoom out"
          >
            <ZoomOut className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="min-w-10 text-center text-sm leading-5 text-white">
            {zoom}%
          </span>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={handleZoomIn}
            disabled={zoom >= 300}
            aria-label="Zoom in"
          >
            <ZoomIn className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Close Button */}
      <button
        className="absolute end-4 top-4 z-10 hover:opacity-70 transition-opacity"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleClose();
        }}
        aria-label="Close image viewer"
        tabIndex={0}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5 text-gray-100"
        >
          <path d="M14.2548 4.75488C14.5282 4.48152 14.9717 4.48152 15.2451 4.75488C15.5184 5.02825 15.5184 5.47175 15.2451 5.74512L10.9902 10L15.2451 14.2549L15.3349 14.3652C15.514 14.6369 15.4841 15.006 15.2451 15.2451C15.006 15.4842 14.6368 15.5141 14.3652 15.335L14.2548 15.2451L9.99995 10.9902L5.74506 15.2451C5.4717 15.5185 5.0282 15.5185 4.75483 15.2451C4.48146 14.9718 4.48146 14.5282 4.75483 14.2549L9.00971 10L4.75483 5.74512L4.66499 5.63477C4.48589 5.3631 4.51575 4.99396 4.75483 4.75488C4.99391 4.51581 5.36305 4.48594 5.63471 4.66504L5.74506 4.75488L9.99995 9.00977L14.2548 4.75488Z" />
        </svg>
      </button>

      {/* Image Container */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-viewer-title"
        aria-describedby="image-viewer-description"
        data-state="open"
        className={`radix-state-open:animate-contentShow focus:outline-hidden relative flex h-full w-full items-center justify-center overflow-hidden ${
          zoom > 100
            ? isDragging
              ? "cursor-grabbing"
              : "cursor-grab"
            : "cursor-zoom-in"
        }`}
        tabIndex={-1}
        style={{ pointerEvents: "auto" }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleCanvasClick}
        onDoubleClick={handleDoubleClick}
      >
        {/* Screen reader title */}
        <div id="image-viewer-title" className="sr-only">
          Image Viewer
        </div>
        <div id="image-viewer-description" className="sr-only">
          {imageAlt}
        </div>

        <div
          ref={imageFrameRef}
          className="relative select-none transition-transform duration-100"
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom / 100})`,
          }}
        >
          {/* Loading Indicator */}
          {isImageLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg">
              <div className="flex items-center space-x-2">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-white border-t-transparent" />
                <span className="text-sm text-white">Loading...</span>
              </div>
            </div>
          )}

          <Image
            draggable={false}
            className={`object-contain transition-opacity duration-300 ${
              isImageLoading ? "opacity-0" : "opacity-100"
            }`}
            src={imageSrc}
            alt={imageAlt}
            width={1200}
            height={800}
            style={{
              maxHeight: "85vh",
              maxWidth: "90vw",
              height: "auto",
              width: "auto",
            }}
            sizes="(max-width: 768px) 90vw, 85vw"
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
        </div>
      </div>
    </div>
  );
};
