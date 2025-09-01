"use client";

import { Upload } from "lucide-react";

interface DragDropOverlayProps {
  isVisible: boolean;
  isDragOver: boolean;
}

export const DragDropOverlay = ({
  isVisible,
  isDragOver,
}: DragDropOverlayProps) => {
  if (!isVisible) return null;

  return (
    <div
      className={`absolute inset-0 z-50 flex items-center justify-center transition-colors duration-200 ${
        isDragOver
          ? "bg-accent/30 backdrop-blur-sm"
          : "bg-muted/20 backdrop-blur-sm"
      }`}
    >
      <div
        className={`flex flex-col items-center justify-center p-8 rounded-2xl border-2 border-dashed transition-all duration-200 ${
          isDragOver
            ? "border-primary bg-card/95 text-foreground scale-105 shadow-lg"
            : "border-border bg-card/90 text-muted-foreground"
        }`}
      >
        <Upload
          className={`w-12 h-12 mb-4 transition-all duration-200 ${
            isDragOver ? "text-foreground scale-110" : "text-muted-foreground"
          }`}
        />
        <h3 className="text-xl font-semibold mb-2">Add anything</h3>
        <p className="text-sm opacity-80">
          Drop files here to add them to the conversation
        </p>
      </div>
    </div>
  );
};
