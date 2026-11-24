"use client";

import {
  type PropsWithChildren,
  useState,
  type FC,
  isValidElement,
} from "react";
import {
  XIcon,
  PlusIcon,
  FileText,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
} from "@/components/ui/avatar";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { useAttachmentSrc } from "@/hooks/use-attachment-src";
import { attachmentKindLabel, formatFileSize, type AttachmentKind } from "@/components/assistant-ui/attachments";
import { cn } from "@/lib/utils";

type AttachmentPreviewProps = {
  src: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain transition-opacity duration-300 motion-reduce:transition-none",
        isLoaded
          ? "aui-attachment-preview-image-loaded opacity-100"
          : "aui-attachment-preview-image-loading opacity-0",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc();

  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger cursor-zoom-in"
        asChild
      >
        {isValidElement(children) ? (
          children
        ) : (
          <button type="button">{children}</button>
        )}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&>button]:hover:bg-foreground/80 [&_svg]:text-background p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">
          Image Attachment Preview
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc();

  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage
        src={src}
        alt="Attachment preview"
        className="aui-attachment-tile-image rounded-none object-cover"
      />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground/80 size-6 stroke-[1.5]" />
      </AvatarFallback>
    </Avatar>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const fileName = useAuiState((s) => s.attachment.name);
  // 类型/大小：adapter 在附件对象上挂了 kind/size 扩展字段（composer 与
  // 乐观 user 消息都带）。缺失时从 contentType/type 退化推导——chip 至少
  // 显示"文档"，不显示空白。
  const kindLabel = useAuiState((s) => {
    const a = s.attachment as { kind?: AttachmentKind; type: string; contentType?: string };
    if (a.kind) return attachmentKindLabel(a.kind);
    if (a.type === "image") return "图片";
    const mime = a.contentType ?? "";
    if (mime.startsWith("video/")) return "视频";
    if (mime.startsWith("audio/")) return "音频";
    return "文档";
  });
  const size = useAuiState((s) => {
    const n = (s.attachment as { size?: number }).size;
    return typeof n === "number" && n > 0 ? n : 0;
  });

  // An attachment on a submission is still being prepared, whether or not the
  // adapter reports progress while it uploads.
  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? "error"
      : s.attachment.status.type === "running" ||
          (s.optional.message?.submission !== undefined &&
            s.attachment.status.type !== "complete")
        ? "uploading"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? "Upload failed")
      : undefined,
  );

  const sizeLabel = size > 0 ? formatFileSize(size) : undefined;

  return (
    <TooltipProvider>
      <Tooltip>
        <AttachmentPrimitive.Root
          className={cn(
            "aui-attachment-root relative",
            isComposer &&
              "animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none",
            isImage &&
              !isComposer &&
              "aui-attachment-root-message only:*:first:size-24",
            // 图片 composer 附件：tile 下补一行名字/大小（需求：chip 显示
            // 类型/文件名/大小）。
            isComposer && isImage && "flex flex-col items-center gap-1",
          )}
        >
          {isImage ? (
            <AttachmentPreviewDialog>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "aui-attachment-tile bg-muted hover:after:bg-foreground/10 focus-visible:ring-ring/50 relative size-14 cursor-pointer overflow-hidden rounded-[calc(var(--composer-radius,1rem)-var(--composer-padding,8px))] transition-transform outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:transition-colors after:ring-inset focus-visible:ring-1 active:scale-[0.96] motion-reduce:transition-none dark:after:ring-white/10",
                    isError &&
                      "after:ring-destructive/60 dark:after:ring-destructive/60",
                  )}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.click();
                    } else if (e.key === " ") {
                      e.preventDefault();
                    }
                  }}
                  onKeyUp={(e) => {
                    if (e.key === " ") e.currentTarget.click();
                  }}
                  aria-label={`${kindLabel} attachment${
                    isError ? ", upload failed" : isUploading ? ", uploading" : ""
                  }`}
                >
                  <AttachmentThumb />
                  {isUploading && (
                    <div
                      aria-hidden="true"
                      className="aui-attachment-tile-uploading bg-background/60 animate-in fade-in-0 absolute inset-0 flex items-center justify-center backdrop-blur-[2px] motion-reduce:animate-none"
                    >
                      <Loader2Icon className="text-muted-foreground size-[var(--size-icon-lg)] animate-spin" />
                    </div>
                  )}
                  {isError && (
                    <div
                      aria-hidden="true"
                      className="aui-attachment-tile-error bg-background/70 animate-in fade-in-0 absolute inset-0 flex items-center justify-center backdrop-blur-[2px] motion-reduce:animate-none"
                    >
                      <AlertCircleIcon className="text-destructive size-[var(--size-icon-lg)]" />
                    </div>
                  )}
                </div>
              </TooltipTrigger>
            </AttachmentPreviewDialog>
          ) : (
            // 视频 / 音频 / 文档：没有原生多模态块，渲染成信息 chip
            // （名字 + 类型 + 大小）；模型实际拿到的是 prompt 里的绝对路径。
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "aui-attachment-file-chip border-border bg-muted/60 flex min-w-0 max-w-[220px] items-center gap-2 rounded-[10px] border px-2 py-1.5 text-start",
                  isComposer && "pe-7",
                  isError && "border-destructive/60",
                )}
                role="group"
                aria-label={`${kindLabel} ${fileName}`}
              >
                <FileText className="text-muted-foreground size-[var(--size-icon-lg)] shrink-0 stroke-[1.5]" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-foreground truncate text-[12px] leading-4">
                    {fileName}
                  </span>
                  <span
                    className={cn(
                      "truncate text-[10px] leading-3",
                      isError ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {isError
                      ? (errorMessage ?? "不可发送")
                      : [kindLabel, sizeLabel].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </div>
            </TooltipTrigger>
          )}
          {isComposer && <AttachmentRemove />}
          {isComposer && isImage && (
            <>
              <span
                className="text-foreground max-w-14 truncate text-[10px] leading-3"
                title={fileName}
              >
                {fileName}
              </span>
              <span className="text-muted-foreground max-w-14 truncate text-[9px] leading-3">
                {[kindLabel, sizeLabel].filter(Boolean).join(" · ")}
              </span>
            </>
          )}
        </AttachmentPrimitive.Root>
        <TooltipContent side="top">
          <AttachmentPrimitive.Name />
          {errorMessage && (
            <p className="aui-attachment-error-message">{errorMessage}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="Remove file"
        className="aui-attachment-tile-remove absolute end-1 top-1 size-5 rounded-full bg-black/50! text-white after:absolute after:-inset-1.5 hover:bg-black/70! hover:text-white! active:scale-[0.96] motion-reduce:transition-none"
        side="top"
      >
        <XIcon className="aui-attachment-remove-icon size-[var(--size-icon-sm)] stroke-[2.5]" />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-(--hover-wash)-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-(--hover-wash)-foreground/30 size-7 rounded-full active:scale-[0.96] motion-reduce:transition-none"
        aria-label="Add Attachment"
      >
        <PlusIcon className="aui-attachment-add-icon size-[var(--size-icon-lg)]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};
