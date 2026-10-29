/** Stable 10% selection of opaque operation IDs; never hash user content. */
export function sampleDiagnosticOperation(operationId: string): boolean {
  let hash = 2166136261;
  for (let index = 0; index < operationId.length; index++) {
    hash = Math.imul(hash ^ operationId.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % 10 === 0;
}
