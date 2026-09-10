import {
  createMiosaAcquisitionDiagnostics,
  miosaErrorDiagnostics,
} from "../miosa-acquisition-diagnostics";

describe("Miosa acquisition diagnostics", () => {
  it("retains actionable server identifiers, not raw errors or rejected values", () => {
    const error = Object.assign(
      new Error("Bearer msk_private secret command output"),
      {
        name: "ValidationError",
        status: 422,
        code: "INVALID_RESOURCE_SHAPE",
        requestId: "GNQ_valid-request-123",
        retryable: false,
        details: {
          errors: [
            {
              loc: ["body", "memory_mb"],
              input: "private file",
              msg: "secret",
            },
            { path: ["metadata", "private-user-key"], input: "private value" },
          ],
        },
        responseBody: "private",
        cause: { secret: "private" },
      },
    );
    expect(miosaErrorDiagnostics(error)).toEqual({
      error_name: "ValidationError",
      error_http_status: 422,
      error_code: "INVALID_RESOURCE_SHAPE",
      error_request_id: "GNQ_valid-request-123",
      error_retryable: false,
      validation_fields: ["memory_mb", "metadata"],
    });
    expect(JSON.stringify(miosaErrorDiagnostics(error))).not.toMatch(
      /private|secret|Bearer/,
    );
  });

  it("drops secrets disguised as identifiers and malformed or unbounded fields", () => {
    const previous = process.env.MIOSA_API_KEY;
    process.env.MIOSA_API_KEY = "SensitiveCanaryError";
    try {
      expect(
        miosaErrorDiagnostics({
          name: "SensitiveCanaryError",
          code: "msk_secret",
          requestId: "prefixSensitiveCanaryError",
          status: "422",
          retryable: "false",
        }),
      ).toEqual({
        error_name: "UnknownError",
        error_code: undefined,
        error_request_id: undefined,
        error_http_status: undefined,
        error_retryable: undefined,
        validation_fields: undefined,
      });
      for (const requestId of [
        "msk_private",
        "https://host/?token=secret",
        "bad\nline",
        "x".repeat(129),
      ]) {
        expect(
          miosaErrorDiagnostics({ requestId }).error_request_id,
        ).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env.MIOSA_API_KEY;
      else process.env.MIOSA_API_KEY = previous;
    }
  });

  it("tolerates arbitrary errors without affecting fallback", () => {
    for (const error of [
      null,
      "raw private output",
      Object.defineProperty({}, "details", {
        get() {
          throw new Error("getter");
        },
      }),
    ]) {
      expect(miosaErrorDiagnostics(error)).toEqual({
        error_name: "UnknownError",
      });
    }
    expect(miosaErrorDiagnostics(new Error("private"))).toMatchObject({
      error_name: "Error",
    });
  });

  it("reports each completed stage and rethrows the original failure", async () => {
    const onDiagnostic = jest.fn();
    const step = createMiosaAcquisitionDiagnostics({
      templateId: "hackerai-tools",
      workspaceName: "private-stable-name",
      onDiagnostic,
    });
    const error = Object.assign(new Error("private"), {
      name: "ValidationError",
      status: 409,
      code: "NAME_CONFLICT",
      requestId: "request123",
    });
    await expect(step("client_init", async () => "client")).resolves.toBe(
      "client",
    );
    await expect(
      step("get_or_create", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(onDiagnostic.mock.calls.map(([d]) => [d.stage, d.outcome])).toEqual([
      ["client_init", "success"],
      ["get_or_create", "failure"],
    ]);
    expect(onDiagnostic.mock.calls[1][0]).toMatchObject({
      error_http_status: 409,
      error_code: "NAME_CONFLICT",
      error_request_id: "request123",
      stage_duration_ms: expect.any(Number),
      acquisition_duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private");
  });

  it("treats lookup misses as expected and ignores broken diagnostic sinks", async () => {
    const onDiagnostic = jest.fn();
    const step = createMiosaAcquisitionDiagnostics({
      templateId: "private-template",
      workspaceName: "private-name",
      onDiagnostic,
    });
    const missing = Object.assign(new Error("private"), {
      name: "NotFoundError",
      status: 404,
    });
    await expect(
      step("lookup_existing", async () => {
        throw missing;
      }),
    ).rejects.toBe(missing);
    expect(onDiagnostic.mock.calls[0][0]).toMatchObject({
      outcome: "not_found",
      requested_template: "custom",
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private");
    onDiagnostic.mockImplementation(() => {
      throw new Error("logging failed");
    });
    await expect(step("enrollment", async () => true)).resolves.toBe(true);
    await expect(
      step("get_or_create", async () => {
        throw missing;
      }),
    ).rejects.toBe(missing);
  });
});
