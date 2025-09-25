import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface Source {
  title?: string;
  url: string;
  text?: string;
  publishedDate?: string;
}

interface SourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Source[];
}

export const SourcesDialog = ({
  open,
  onOpenChange,
  sources,
}: SourcesDialogProps) => {
  const getFaviconUrl = (domain: string) => {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  };

  const getDomain = (url: string) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}`;
    } catch {
      return url;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl w-full"
        aria-describedby={undefined}
      >
        <div className="flex w-full flex-row items-center justify-between border-b px-1 pb-3">
          <DialogTitle>Citations</DialogTitle>
        </div>
        <div className="h-[60vh] max-h-[700px] w-full overflow-y-auto">
          <div className="flex w-full flex-col mt-0">
            <ul className="flex flex-col px-1 py-2">
              {sources.map((src, idx) => {
                const domain = getDomain(src.url);
                const displayHost = (() => {
                  try {
                    return new URL(src.url).hostname.replace(/^www\./, "");
                  } catch {
                    return domain;
                  }
                })();
                return (
                  <li key={`link-${idx}`}>
                    <a
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:bg-secondary flex flex-col gap-1 rounded-xl px-3 py-2.5"
                    >
                      <div className="line-clamp-1 flex h-6 items-center gap-2 text-xs">
                        <img
                          alt=""
                          width={20}
                          height={20}
                          className="bg-background rounded-full object-cover w-4 h-4"
                          src={getFaviconUrl(domain)}
                        />
                        {displayHost}
                      </div>
                      <div className="line-clamp-2 text-sm font-semibold break-words">
                        {src.title || src.url}
                      </div>
                      {src.text && (
                        <div className="text-muted-foreground line-clamp-2 text-sm leading-snug font-normal">
                          <span>{src.text}</span>
                        </div>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
