import "server-only";

import { UIMessagePart } from "ai";

type StreamWriter = {
  write: (data: any) => void;
};

// Upload status notifications
export const writeUploadStartStatus = (writer: StreamWriter): void => {
  writer.write({
    type: "data-upload-status",
    data: {
      message: "Uploading attachments to the computer",
      isUploading: true,
    },
    transient: true,
  });
};

export const writeUploadCompleteStatus = (writer: StreamWriter): void => {
  writer.write({
    type: "data-upload-status",
    data: {
      message: "",
      isUploading: false,
    },
    transient: true,
  });
};

// Summarization notifications
export const writeSummarizationStarted = (writer: StreamWriter): void => {
  writer.write({
    type: "data-summarization",
    id: "summarization-status",
    data: {
      status: "started",
      message: "Summarizing chat context",
    },
  });
};

export const writeSummarizationCompleted = (writer: StreamWriter): void => {
  writer.write({
    type: "data-summarization",
    id: "summarization-status",
    data: {
      status: "completed",
      message: "Chat context summarized",
    },
  });
};

export const createSummarizationCompletedPart = (): UIMessagePart<
  any,
  any
> => ({
  type: "data-summarization" as const,
  id: "summarization-status",
  data: {
    status: "completed",
    message: "Chat context summarized",
  },
});
