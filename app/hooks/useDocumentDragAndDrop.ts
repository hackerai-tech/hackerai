import { useEffect } from "react";

type DragHandler = (e: DragEvent) => void;

export const useDocumentDragAndDrop = (handlers: {
  handleDragEnter: DragHandler;
  handleDragLeave: DragHandler;
  handleDragOver: DragHandler;
  handleDrop: DragHandler;
}) => {
  const { handleDragEnter, handleDragLeave, handleDragOver, handleDrop } =
    handlers;

  useEffect(() => {
    const onEnter = (e: DragEvent) => handleDragEnter(e);
    const onLeave = (e: DragEvent) => handleDragLeave(e);
    const onOver = (e: DragEvent) => handleDragOver(e);
    const onDrop = (e: DragEvent) => handleDrop(e);

    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("dragover", onOver);
    document.addEventListener("drop", onDrop);

    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);
};
