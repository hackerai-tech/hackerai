/** Preview references are attachments, separate from model input file tokens. */
export const extractPreviewFileIdsFromParts = (
  parts: readonly any[],
): string[] =>
  Array.from(
    new Set<string>(
      parts.flatMap((part) =>
        part?.type === "tool-file" && Array.isArray(part.output?.previewFiles)
          ? part.output.previewFiles.flatMap((preview: any) =>
              typeof preview?.fileId === "string" && preview.fileId.length > 0
                ? [preview.fileId]
                : [],
            )
          : [],
      ),
    ),
  );
