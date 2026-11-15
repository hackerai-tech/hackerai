// Indexed in-memory storage exercises the actual mutation handlers and durable
// state transitions. Live Convex acceptance separately proves transaction semantics.
export function database() {
  const tables: Record<string, any[]> = {};
  let sequence = 0;
  const db = {
    query(table: string) {
      tables[table] ??= [];
      let predicates: Array<(row: any) => boolean> = [];
      let descending = false;
      const results = () =>
        tables[table]
          .filter((row) => predicates.every((p) => p(row)))
          .sort((a, b) =>
            descending
              ? b._creationTime - a._creationTime
              : a._creationTime - b._creationTime,
          );
      const chain = {
        withIndex(_index: string, callback: (query: any) => unknown) {
          const query = {
            eq(field: string, value: unknown) {
              predicates.push((row) => row[field] === value);
              return query;
            },
            gt(field: string, value: any) {
              predicates.push((row) => row[field] > value);
              return query;
            },
            lte(field: string, value: any) {
              predicates.push((row) => row[field] <= value);
              return query;
            },
            lt(field: string, value: any) {
              predicates.push((row) => row[field] < value);
              return query;
            },
          };
          callback(query);
          return chain;
        },
        order(value: string) {
          descending = value === "desc";
          return chain;
        },
        async first() {
          return results()[0] ?? null;
        },
        async unique() {
          const rows = results();
          if (rows.length > 1) throw new Error("Duplicate");
          return rows[0] ?? null;
        },
        async take(n: number) {
          return results().slice(0, n);
        },
        async paginate({
          cursor,
          numItems,
        }: {
          cursor: string | null;
          numItems: number;
        }) {
          const offset = Number(cursor ?? 0);
          const rows = results();
          return {
            page: rows.slice(offset, offset + numItems),
            isDone: offset + numItems >= rows.length,
            continueCursor: String(offset + numItems),
            splitCursor: null,
            pageStatus: null,
          };
        },
      };
      return chain;
    },
    async insert(table: string, row: any) {
      const id = `${table}-${++sequence}`;
      (tables[table] ??= []).push({ ...row, _id: id, _creationTime: sequence });
      return id;
    },
    async get(id: string) {
      return (
        Object.values(tables)
          .flat()
          .find((row) => row._id === id) ?? null
      );
    },
    async patch(id: string, patch: any) {
      const row = await db.get(id);
      if (!row) throw new Error("missing");
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete row[key];
        else row[key] = value;
      }
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex((row) => row._id === id);
        if (index >= 0) rows.splice(index, 1);
      }
    },
  };
  return { db, tables, scheduler: { runAfter: jest.fn() } };
}
