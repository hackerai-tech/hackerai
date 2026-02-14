export const runs = { cancel: () => Promise.resolve() };
export const streams = {
  define: <T>(opts: { id: string }) => ({ id: opts.id }) as unknown as T,
};
