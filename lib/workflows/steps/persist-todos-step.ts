import { updateChat } from "@/lib/db/actions";
import type { Todo } from "@/types";

export async function persistTodosStep(args: {
  chatId: string;
  todos: Todo[];
}): Promise<void> {
  "use step";
  if (!args.todos || args.todos.length === 0) return;
  await updateChat({
    chatId: args.chatId,
    todos: args.todos,
  });
}
