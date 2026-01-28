"use client";

import { ImageIcon, FileIcon } from "lucide-react";
import { SharedMessagePartHandler } from "./components/SharedMessagePartHandler";

interface MessagePart {
  type: string;
  text?: string;
  placeholder?: boolean;
  state?: string;
  input?: any;
  output?: any;
  toolCallId?: string;
  errorText?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  content?: string;
  update_time: number;
}

interface SharedMessagesProps {
  messages: Message[];
  shareDate: number;
}

export function SharedMessages({ messages, shareDate }: SharedMessagesProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-muted-foreground">
          No messages in this conversation
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Shared conversation notice */}
      <div
        className="text-center text-[12px] font-normal"
        style={{ color: "rgb(155, 155, 155)" }}
      >
        This is a copy of a conversation between HackerAI & Anonymous.
      </div>

      {/* Messages */}
      {messages.map((message) => {
        const isUser = message.role === "user";

        // Separate file/image placeholders from other parts
        const filePlaceholders = message.parts.filter(
          (part) =>
            (part.type === "file" || part.type === "image") && part.placeholder,
        );
        const otherParts = message.parts.filter(
          (part) =>
            !(
              (part.type === "file" || part.type === "image") &&
              part.placeholder
            ),
        );

        return (
          <div
            key={message.id}
            className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
          >
            <div
              className={`${
                isUser
                  ? "w-full flex flex-col gap-1 items-end"
                  : "w-full text-foreground"
              } overflow-hidden`}
            >
              {/* File/Image placeholders - rendered outside bubble */}
              {isUser && filePlaceholders.length > 0 && (
                <div className="flex gap-2 flex-wrap mt-1 max-w-[80%] justify-end">
                  {filePlaceholders.map((part, idx) => {
                    const isImage = part.type === "image";
                    return (
                      <div
                        key={idx}
                        className="text-muted-foreground flex items-center gap-2 whitespace-nowrap"
                      >
                        {isImage ? (
                          <ImageIcon className="w-5 h-5" aria-hidden="true" />
                        ) : (
                          <FileIcon className="w-5 h-5" aria-hidden="true" />
                        )}
                        <span>
                          {isImage ? "Uploaded an image" : "Uploaded a file"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Message bubble with other parts */}
              {otherParts.length > 0 && (
                <div
                  className={`${
                    isUser
                      ? "max-w-[80%] bg-secondary rounded-[18px] px-4 py-1.5 data-[multiline]:py-3 rounded-se-lg text-primary-foreground border border-border"
                      : "w-full prose space-y-3 max-w-none dark:prose-invert min-w-0"
                  } overflow-hidden`}
                >
                  {/* Message Parts */}
                  {isUser ? (
                    <div className="whitespace-pre-wrap">
                      {otherParts.map((part, idx) => (
                        <SharedMessagePartHandler
                          key={idx}
                          part={part}
                          partIndex={idx}
                          isUser={isUser}
                          allParts={otherParts}
                        />
                      ))}
                    </div>
                  ) : (
                    otherParts.map((part, idx) => (
                      <SharedMessagePartHandler
                        key={idx}
                        part={part}
                        partIndex={idx}
                        isUser={isUser}
                        allParts={otherParts}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
