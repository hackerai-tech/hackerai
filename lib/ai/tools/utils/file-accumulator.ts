import type { Id } from "@/convex/_generated/dataModel";

export class FileAccumulator {
  private ids: Set<Id<"files">> = new Set();

  add(id: Id<"files">) {
    this.ids.add(id);
  }

  addMany(ids: Array<Id<"files">>) {
    for (const id of ids) this.ids.add(id);
  }

  getAll(): Array<Id<"files">> {
    return Array.from(this.ids);
  }

  clear() {
    this.ids.clear();
  }
}
