"use client";

import { Trash2 } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import type { Memory } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ManageMemoriesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ManageMemoriesDialog = ({
  open,
  onOpenChange,
}: ManageMemoriesDialogProps) => {
  const memories = useQuery(api.memories.getUserMemories, open ? {} : "skip");
  const deleteMemory = useMutation(api.memories.deleteUserMemory);
  const deleteAllMemories = useMutation(api.memories.deleteAllUserMemories);

  const handleDeleteMemory = async (memoryId: string) => {
    try {
      await deleteMemory({ memoryId });
    } catch (error) {
      console.error("Failed to delete memory:", error);
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to delete memory"
          : error instanceof Error
            ? error.message
            : "Failed to delete memory";
      toast.error(errorMessage);
    }
  };

  const handleDeleteAllMemories = async () => {
    try {
      await deleteAllMemories({});
    } catch (error) {
      console.error("Failed to delete all memories:", error);
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to delete all memories"
          : error instanceof Error
            ? error.message
            : "Failed to delete all memories";
      toast.error(errorMessage);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] w-full flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 py-4">
          <DialogTitle className="text-lg font-normal text-left">
            Saved memories
          </DialogTitle>
          <div className="text-xs text-muted-foreground text-left mt-1">
            HackerAI tries to remember most of your chats, but it may forget
            things over time. Saved memories are never forgotten.
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden px-6 pb-6">
          <div className="h-[400px] rounded-lg border border-border overflow-hidden">
            <div className="overflow-y-auto text-sm h-full text-foreground">
              {memories === undefined ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-muted-foreground">
                    Loading memories...
                  </div>
                </div>
              ) : memories.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-center">
                    <div className="mb-2 text-muted-foreground">
                      No memories saved yet
                    </div>
                    <div className="text-sm text-muted-foreground/70">
                      HackerAI will automatically save relevant information as
                      you chat.
                    </div>
                  </div>
                </div>
              ) : (
                <table className="w-full border-separate border-spacing-0">
                  <tbody>
                    {memories.map((memory: Memory) => (
                      <tr key={memory.memory_id}>
                        <td className="align-top px-3 text-left border-b-[0.5px] border-border/50">
                          <div className="flex min-h-[40px] items-center">
                            <div className="py-2 whitespace-pre-wrap">
                              {memory.content}
                            </div>
                          </div>
                        </td>
                        <td className="align-top px-3 text-right border-b-[0.5px] border-border/50">
                          <div className="flex justify-end min-h-[40px] items-center">
                            <div className="text-md flex items-center justify-end gap-2">
                              <button
                                onClick={() =>
                                  handleDeleteMemory(memory.memory_id)
                                }
                                aria-label="Remove memory"
                                className="text-muted-foreground hover:text-destructive transition-colors"
                              >
                                <Trash2 className="h-5 w-5" />
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {memories && memories.length > 0 && (
            <div className="mt-4 flex justify-end">
              <Button
                onClick={handleDeleteAllMemories}
                variant="outline"
                className="border-destructive text-destructive hover:bg-destructive/10"
              >
                Delete all
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export { ManageMemoriesDialog };
