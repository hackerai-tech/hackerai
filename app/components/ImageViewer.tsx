import Image from "next/image";
import { useState, useEffect, useRef } from "react";

interface ImageViewerProps {
  isOpen: boolean;
  onClose: () => void;
  imageSrc: string;
  imageAlt: string;
}

export const ImageViewer = ({
  isOpen,
  onClose,
  imageSrc,
  imageAlt,
}: ImageViewerProps) => {
  const [isImageLoading, setIsImageLoading] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset loading state when imageSrc changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsImageLoading(true);
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
      {/* Close Button */}
      <button
        className="absolute end-4 top-4 hover:opacity-70 transition-opacity"
        type="button"
        onClick={handleClose}
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
        className="radix-state-open:animate-contentShow shadow-xl focus:outline-hidden relative"
        tabIndex={-1}
        style={{ pointerEvents: "auto" }}
      >
        {/* Screen reader title */}
        <div id="image-viewer-title" className="sr-only">
          Image Viewer
        </div>
        <div id="image-viewer-description" className="sr-only">
          {imageAlt}
        </div>

        <div className="relative max-h-[85vh] max-w-[90vw]">
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
            className={`h-full w-full object-contain transition-opacity duration-300 ${
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
