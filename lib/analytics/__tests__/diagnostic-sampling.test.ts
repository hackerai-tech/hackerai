import { sampleDiagnosticOperation } from "../diagnostic-sampling";

it("selects a stable tenth of opaque IDs without depending on their provider prefix", () => {
  for (const prefix of ["call_", "toolu_", "connection:"]) {
    const ids = Array.from(
      { length: 10_000 },
      (_, index) => `${prefix}${index}`,
    );
    const selected = ids.filter(sampleDiagnosticOperation);
    expect(selected.length).toBeGreaterThan(850);
    expect(selected.length).toBeLessThan(1150);
    expect(ids.filter(sampleDiagnosticOperation)).toEqual(selected);
  }
});
