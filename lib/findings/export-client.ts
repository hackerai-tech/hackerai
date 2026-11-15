"use client";

import type { FindingDetailRecord } from "@/types/finding";
import { downloadFile } from "@/lib/utils/file-download";
import {
  createFindingsReport,
  exportFindingsReport,
  type FindingExportFormat,
} from "./export";

let fontRequest: Promise<ArrayBuffer> | undefined;
function getPdfFont() {
  fontRequest ??= fetch("/fonts/report/NotoSans-Regular.ttf")
    .then((response) => {
      if (!response.ok) throw new Error("PDF font unavailable");
      return response.arrayBuffer();
    })
    .catch((error) => {
      fontRequest = undefined;
      throw error;
    });
  return fontRequest;
}

export async function downloadFindingsReport(
  findings: FindingDetailRecord[],
  format: FindingExportFormat,
) {
  const report = createFindingsReport(findings, window.location.origin);
  const file = await exportFindingsReport(
    report,
    format,
    format === "pdf" ? await getPdfFont() : undefined,
  );
  return downloadFile(file);
}
