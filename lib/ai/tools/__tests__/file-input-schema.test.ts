import { asSchema } from "ai";
import {
  createFileToolSchema,
  createFileWriteToolSchema,
  createAgentToolSchemaSet,
} from "../schemas";

describe("file mutation schema", () => {
  test.each(["write", "append"])(
    "%s requires explicit text, including when the intended content is empty",
    async (action) => {
      const input = { action, path: "/project/notes.txt" };
      const schema = asSchema(createFileWriteToolSchema().inputSchema);

      expect(await schema.validate?.(input)).toMatchObject({ success: false });
      for (const text of ["", "complete content\n"]) {
        expect(await schema.validate?.({ ...input, text })).toMatchObject({
          success: true,
          value: { ...input, text },
        });
      }
      // The remaining file tool must not provide an optional-content route.
      const file = asSchema(
        createFileToolSchema({ supportsView: true }).inputSchema,
      );
      expect(
        await file.validate?.({ ...input, text: "content" }),
      ).toMatchObject({ success: false });
    },
  );

  test("publishes required content in a plain object for provider compatibility", () => {
    const schema = asSchema(
      createAgentToolSchemaSet().file_write.inputSchema,
    ).jsonSchema;
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        action: { enum: ["write", "append"] },
        text: { type: "string" },
      },
      required: expect.arrayContaining(["action", "path", "text"]),
    });
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
    expect(createAgentToolSchemaSet({ mode: "ask" })).not.toHaveProperty(
      "file_write",
    );
  });

  test.each([true, false])(
    "read and edit need no content; view follows supportsView=%s",
    async (supportsView) => {
      const schema = asSchema(
        createFileToolSchema({ supportsView }).inputSchema,
      );
      expect(
        await schema.validate?.({ action: "read", path: "/project/notes.txt" }),
      ).toMatchObject({ success: true });
      expect(
        await schema.validate?.({ action: "view", path: "/project/image.png" }),
      ).toMatchObject({ success: supportsView });
      expect(
        await schema.validate?.({
          action: "edit",
          path: "/project/notes.txt",
          edits: [{ find: "before", replace: "after" }],
        }),
      ).toMatchObject({ success: true });
    },
  );
});
