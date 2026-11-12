import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownBlock } from "@/components/markdown/markdown";

import { aiopcFileUrl, type AiopcConnection } from "../aiopc-client";
import { taskDeliverableAbsolutePath, type TaskDeliverable } from "./task-client";
import { taskError, taskText } from "./task-copy";

const markdown = new Set(["md", "markdown", "mdx"]);
const text = new Set(["txt", "json", "csv", "tsv", "log", "yaml", "yml", "xml", "html", "css", "js", "ts"]);
const images = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);
const videos = new Set(["mp4", "webm", "m4v", "mov"]);
const audio = new Set(["mp3", "m4a", "aac", "ogg", "wav", "flac"]);

export function TaskDeliverablePreview({ connection, projectPath, item, onBack }: {
  connection: AiopcConnection;
  projectPath: string;
  item: TaskDeliverable;
  onBack?: () => void;
}) {
  const name = item.path.split("/").at(-1) || "deliverable";
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() ?? "" : "";
  const src = aiopcFileUrl(connection, projectPath, taskDeliverableAbsolutePath(projectPath, item));
  const isText = markdown.has(extension) || text.has(extension);
  const [previewError, setPreviewError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const preview = useQuery({
    queryKey: ["aiopc", projectPath, "task-deliverable", item.path],
    enabled: isText,
    queryFn: async ({ signal }) => {
      const response = await fetch(src, { signal });
      if (!response.ok) throw new Error(taskText("previewFailed"));
      return response.text();
    },
    retry: false,
  });

  async function download() {
    setDownloading(true);
    setDownloadError("");
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(taskText("previewFailed"));
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
    } catch (error) {
      setDownloadError(taskError(error, "previewFailed"));
    } finally {
      setDownloading(false);
    }
  }

  let content;
  if (previewError || (isText && preview.isError)) {
    content = <p role="alert" className="p-4 text-destructive">{taskText("previewFailed")}</p>;
  } else if (isText) {
    content = preview.isPending ? <p role="status" className="p-4 text-muted-foreground">{taskText("loadingPreview")}</p>
      : markdown.has(extension) ? <MarkdownBlock className="p-4" text={preview.data ?? ""} />
        : <pre className="whitespace-pre-wrap p-4 font-mono text-xs wrap-anywhere">{preview.data}</pre>;
  } else if (images.has(extension)) {
    content = <img src={src} alt={item.label || name} className="mx-auto max-h-[55dvh] object-contain" onError={() => setPreviewError(true)} />;
  } else if (videos.has(extension)) {
    content = <video src={src} controls className="mx-auto max-h-[55dvh]" onError={() => setPreviewError(true)} />;
  } else if (audio.has(extension)) {
    content = <audio src={src} controls className="m-4 w-[calc(100%-2rem)]" onError={() => setPreviewError(true)} />;
  } else {
    content = <p className="p-4 text-muted-foreground">{taskText("noPreview")}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="max-h-[55dvh] overflow-auto rounded-lg border border-border bg-muted/30">{content}</div>
      {downloadError ? <p role="alert" className="text-sm text-destructive">{downloadError}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {onBack ? <Button type="button" size="sm" variant="outline" onClick={onBack}>{taskText("backToTask")}</Button> : null}
        <Button type="button" size="sm" variant="outline" disabled={downloading} onClick={() => void download()}>
          <Download className="size-3.5" aria-hidden />{taskText(downloading ? "downloading" : "download")}
        </Button>
      </div>
    </div>
  );
}
