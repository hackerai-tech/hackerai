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
  it("accepts cached auxiliary vision fields on single and batch lookups", async () => {
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
    }
  });
});
