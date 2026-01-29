"use client";

import { useRef, useCallback } from "react";
import { Trash2 } from "lucide-react";
import { usePaginatedQuery, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ManageNotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Content component that manages its own state - resets naturally on mount
const ManageNotesDialogContent = () => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const {
    results: allNotes,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.notes.getUserNotesPaginated,
    {},
    { initialNumItems: 25 },
  );

  const deleteNote = useMutation(api.notes.deleteUserNote);
  const deleteAllNotes = useMutation(api.notes.deleteAllUserNotes);

  // Infinite scroll handler
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || status !== "CanLoadMore") return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    // Load more when user scrolls within 100px of the bottom
    if (scrollHeight - scrollTop - clientHeight < 100) {
      loadMore(25);
    }
  }, [status, loadMore]);

  const handleDeleteNote = async (noteId: string) => {
    try {
      await deleteNote({ noteId });
    } catch (error) {
      console.error("Failed to delete note:", error);
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to delete note"
          : error instanceof Error
            ? error.message
            : "Failed to delete note";
      toast.error(errorMessage);
    }
  };

  const handleDeleteAllNotes = async () => {
    try {
      await deleteAllNotes({});
    } catch (error) {
      console.error("Failed to delete all notes:", error);
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to delete all notes"
          : error instanceof Error
            ? error.message
            : "Failed to delete all notes";
      toast.error(errorMessage);
    }
  };

  const isLoading = status === "LoadingFirstPage";
  const isLoadingMore = status === "LoadingMore";

  return (
    <>
      <DialogHeader className="px-6 py-4">
        <DialogTitle className="text-lg font-normal text-left">
          Saved notes
        </DialogTitle>
        <div className="text-xs text-muted-foreground text-left mt-1">
          Notes are saved across all your chats and help HackerAI provide more
          personalized assistance.
        </div>
      </DialogHeader>

      <div className="flex-1 overflow-hidden px-6 pb-6">
        <div className="h-[400px] rounded-lg border border-border overflow-hidden">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="overflow-y-auto text-sm h-full text-foreground"
          >
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="text-muted-foreground">Loading notes...</div>
              </div>
            ) : allNotes.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <div className="text-center">
                  <div className="mb-2 text-muted-foreground">
                    No notes saved yet
                  </div>
                  <div className="text-sm text-muted-foreground/70">
                    HackerAI will save notes as you chat to remember important
                    information.
                  </div>
                </div>
              </div>
            ) : (
              <table className="w-full border-separate border-spacing-0">
                <tbody>
                  {allNotes.map((note) => (
                    <tr key={note.note_id}>
                      <td className="align-top px-3 text-left border-b-[0.5px] border-border/50">
                        <div className="flex min-h-[40px] items-start">
                          <div className="py-2">
                            <div className="font-medium text-foreground">
                              {note.title}
                            </div>
                            <div className="text-muted-foreground whitespace-pre-wrap mt-1">
                              {note.content}
                            </div>
                            {note.tags.length > 0 && (
                              <div className="flex gap-1 mt-2 flex-wrap">
                                {note.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="text-xs px-2 py-0.5 bg-muted rounded-full text-muted-foreground"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="align-top px-3 text-right border-b-[0.5px] border-border/50 w-[60px]">
                        <div className="flex justify-end min-h-[40px] items-center">
                          <div className="text-md flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleDeleteNote(note.note_id)}
                              aria-label="Remove note"
                              className="text-muted-foreground hover:text-destructive transition-colors"
                            >
                              <Trash2 className="h-5 w-5" />
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {isLoadingMore && (
                    <tr>
                      <td colSpan={2} className="py-4 text-center">
                        <div className="text-muted-foreground text-sm">
                          Loading more...
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {allNotes.length > 0 && (
          <div className="mt-4 flex justify-end">
            <Button
              onClick={handleDeleteAllNotes}
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10"
            >
              Delete all
            </Button>
          </div>
        )}
      </div>
    </>
  );
};

// Wrapper component that controls mounting/unmounting of content
const ManageNotesDialog = ({ open, onOpenChange }: ManageNotesDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] w-full flex flex-col gap-0 p-0">
        {open && <ManageNotesDialogContent />}
      </DialogContent>
    </Dialog>
  );
};

export { ManageNotesDialog };
