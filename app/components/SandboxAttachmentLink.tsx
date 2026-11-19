import {
  createContext,
  useCallback,
  useContext,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { FileDetails } from "@/types/file";
import { parseSandboxAttachmentHref } from "@/lib/chat/sandbox-attachment-links";
import { useAttachmentDownload } from "@/app/hooks/useAttachmentDownload";

/**
 * Delivered sandbox paths resolved for one assistant message. Renderers without
 * a provider (shared pages, reasoning) get no download access.
 */
export const SandboxAttachmentContext = createContext<ReadonlyMap<
  string,
  FileDetails
> | null>(null);

const LINK_CLASS_NAME =
  "text-link hover:text-link/80 hover:underline transition-colors duration-200";

function ResolvedSandboxAttachmentLink({
  file,
  href,
  children,
}: {
  file: FileDetails;
  href: string;
  children: ReactNode;
}) {
  const { downloadAttachment, isDownloading } = useAttachmentDownload();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // The fragment is only an inert token; never navigate to it.
      event.preventDefault();
      void downloadAttachment({ fileId: file.fileId, fileName: file.name });
    },
    [downloadAttachment, file.fileId, file.name],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      aria-busy={isDownloading || undefined}
      aria-disabled={isDownloading || undefined}
      className={
        isDownloading
          ? `${LINK_CLASS_NAME} opacity-50 cursor-wait`
          : LINK_CLASS_NAME
      }
    >
      {children}
      <span className="sr-only">, download {file.name}</span>
    </a>
  );
}

/** Inline link for a `sandbox:` path delivered in the same message. */
export function SandboxAttachmentLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const attachments = useContext(SandboxAttachmentContext);
  const path = parseSandboxAttachmentHref(href);
  const file = path ? attachments?.get(path) : undefined;

  if (!file) {
    // Unmatched, pending or ambiguous deliveries stay plain text.
    return <span className="text-muted-foreground">{children}</span>;
  }
  return (
    <ResolvedSandboxAttachmentLink file={file} href={href}>
      {children}
    </ResolvedSandboxAttachmentLink>
  );
}
