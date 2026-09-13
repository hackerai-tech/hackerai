import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: unknown) => config),
  internalMutation: jest.fn((config: unknown) => config),
  query: jest.fn((config: unknown) => config),
  internalQuery: jest.fn((config: unknown) => config),
}));

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    count: jest.fn(),
    sum: jest.fn(),
    insertIfDoesNotExist: jest.fn(),
    deleteIfExists: jest.fn(),
  },
}));

type ValidatorJson = {
  type: string;
  value?:
    | ValidatorJson[]
    | Record<string, { fieldType: ValidatorJson; optional: boolean }>;
};

function getObjectFields(validator: { json: ValidatorJson }) {
  const union = validator.json;
  expect(union.type).toBe("union");

  const object = Array.isArray(union.value)
    ? union.value.find((member) => member.type === "object")
    : undefined;
  expect(object?.type).toBe("object");
  expect(Array.isArray(object?.value)).toBe(false);

  return object?.value as Record<
    string,
    { fieldType: ValidatorJson; optional: boolean }
  >;
}

describe("file storage lookup validators", () => {
  it("returns only URL lookup metadata for single and batch lookups", async () => {
    const { getFileById, getFilesByIds } = await import("../fileStorage");
    const singleValidator = (
      getFileById as unknown as { returns: { json: ValidatorJson } }
    ).returns;
    const batchValidator = (
      getFilesByIds as unknown as { returns: { json: ValidatorJson } }
    ).returns;

    const singleFields = getObjectFields(singleValidator);
    const batchJson = batchValidator.json;
    expect(batchJson.type).toBe("array");
    const batchFields = getObjectFields({
      json: batchJson.value as unknown as ValidatorJson,
    });

    for (const fields of [singleFields, batchFields]) {
      expect(fields.auxiliary_vision_description).toEqual({
        fieldType: { type: "string" },
        optional: true,
      });
      expect(fields.auxiliary_vision_model).toEqual({
        fieldType: { type: "string" },
        optional: true,
      });
      expect(fields.content).toBeUndefined();
      expect(fields.file_token_size).toBeUndefined();
    }

    const storedFile = {
      _id: "file-1",
      _creationTime: 1,
      s3_key: "users/user-1/file.txt",
      user_id: "user-1",
      name: "file.txt",
      media_type: "text/plain",
      size: 42,
      file_token_size: 8,
      content: "private file contents",
      auxiliary_vision_description: "safe cached description",
      auxiliary_vision_model: "vision-model",
      is_attached: true,
      future_private_field: "must not cross the action boundary",
    };
    const db = { get: jest.fn().mockResolvedValue(storedFile) };

    await expect(
      (getFileById as unknown as { handler: Function }).handler(
        { db },
        { fileId: "file-1" },
      ),
    ).resolves.toEqual({
      s3_key: "users/user-1/file.txt",
      user_id: "user-1",
      name: "file.txt",
      media_type: "text/plain",
      size: 42,
      auxiliary_vision_description: "safe cached description",
      auxiliary_vision_model: "vision-model",
    });

    await expect(
      (getFilesByIds as unknown as { handler: Function }).handler(
        { db },
        { fileIds: ["file-1"] },
      ),
    ).resolves.toEqual([
      {
        s3_key: "users/user-1/file.txt",
        user_id: "user-1",
        name: "file.txt",
        media_type: "text/plain",
        size: 42,
        auxiliary_vision_description: "safe cached description",
        auxiliary_vision_model: "vision-model",
      },
    ]);

    db.get.mockResolvedValueOnce({
      _id: "file-2",
      _creationTime: 2,
      user_id: "user-1",
      name: "legacy.txt",
      media_type: "text/plain",
      size: 7,
      file_token_size: 2,
      content: "private legacy contents",
      is_attached: false,
    });
    await expect(
      (getFileById as unknown as { handler: Function }).handler(
        { db },
        { fileId: "file-2" },
      ),
    ).resolves.toEqual({
      user_id: "user-1",
      name: "legacy.txt",
      media_type: "text/plain",
      size: 7,
    });
  });
});
