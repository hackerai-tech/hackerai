/** Extract document text only: no document HTML, scripts, or external resources. */
export async function extractDocxPreview(buffer: ArrayBuffer): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > 512 || !zip.file("word/document.xml")) {
    throw new Error("Invalid or oversized document");
  }

  // Bound actual expanded bytes, not the untrusted ZIP directory sizes. Mammoth
  // reads several XML members; cap the entire archive before handing it over.
  let expandedBytes = 0;
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      // JSZip documents this streaming API but omits it from JSZipObject's types.
      const stream = (
        entry as typeof entry & {
          internalStream(
            type: "uint8array",
          ): import("jszip").JSZipStreamHelper<Uint8Array>;
        }
      ).internalStream("uint8array");
      stream.on("data", (chunk: Uint8Array) => {
        expandedBytes += chunk.length;
        if (expandedBytes > 20 * 1024 * 1024) {
          stream.pause();
          reject(new Error("Document is too large to preview"));
        }
      });
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.resume();
    });
  }
  const { extractRawText } = await import("mammoth");
  const result = await extractRawText({ arrayBuffer: buffer });
  return result.value;
}
