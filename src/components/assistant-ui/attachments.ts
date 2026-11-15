/**
 * 附件通道（图片原生多模态 + 视频/音频/文档文件引用）。
 *
 * 引擎能力（G:\pi-rust-main，2026-11-15 核）：
 *  - 原生多模态**只有图片**：`AgentHarness::prompt_text(text, images)` 把
 *    `rpi_ai::types::ImageContent{data(base64), mimeType}` 拼进
 *    `UserContent::Blocks`；provider 层（openai_completions / anthropic /
 *    openai_responses）逐家转成 image_url / image block。
 *  - 视频 / 音频 / 文档：`rpi_ai::types::Content` 只有
 *    Text/Thinking/Image/ToolCall 四变体，`InputModality` 只有 text/image
 *    ——**没有原生视频/音频/文档消息块**，provider 也没有对应编码路径。
 *    诚实做法 = 落一条**绝对路径引用**进 prompt，让模型用 `read` / `bash`
 *    等工具自行读取；绝不伪装成原生多模态。
 *
 * 因此本模块产出两类载荷：
 *  1. `PiImagePayload`（纯 base64 + mimeType）→ POST /ag-ui `images[]`
 *     → Rust `prompt_with_content` → 引擎原生图片通道。
 *  2. `TurnAttachment`（名字/类型/大小/本地绝对路径）→ 拼进 prompt 的
 *     `[附件]` 说明块 + 乐观 user 消息的附件 chip。
 *
 * 路径来源分两种：
 *  - 「+」按钮 → `@tauri-apps/plugin-dialog` 原生选择器，直拿绝对路径
 *    （HTML `<input type=file>` 拿不到路径，且大文件读字节进 JS 没有意义）。
 *  - 拖放（tauri.conf 的 dragDropEnabled=false → HTML5 File，无路径）：
 *    图片直接读字节走原生通道；其它类型把字节写入宿主临时目录
 *    （`attachment_stage` IPC）再引用该路径；超限则**可见报错**，不静默丢。
 */
import { generateId, type Attachment, type AttachmentAdapter, type CompleteAttachment, type PendingAttachment } from '@assistant-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'

// ── 类型 ────────────────────────────────────────────────────────────────────

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document'

/** POST body images[] 条目（纯 base64，不带 data: 前缀；Rust AguiImage 同形） */
export interface PiImagePayload {
  data: string
  mimeType: string
}

/** 文件引用附件（乐观 user 消息 chip + prompt `[附件]` 块的数据面） */
export interface TurnAttachment {
  id: string
  name: string
  mime: string
  size: number
  /** 本机绝对路径（原生选择器直得 / 拖放经 attachment_stage 落临时文件） */
  path: string
  kind: AttachmentKind
}

/** 附件对象上的扩展元数据（assistant-ui 的 Attachment 类型是开放的，
 *  额外字段经 `fromThreadMessageLike` 的 `...att` 原样存活；UI 与 send
 *  共用同一份，不靠第二个真相源） */
export interface AttachmentMeta {
  kind?: AttachmentKind
  mime?: string
  size?: number
  sourcePath?: string
  /** 已预读的图片 data URL（原生选择器路径；避免 FileReader 二次读） */
  dataUrl?: string
}

export interface AttachmentPlan {
  images: PiImagePayload[]
  imageDataUrls: string[]
  imageNames: string[]
  files: TurnAttachment[]
}

// ── 能力表（单一来源） ──────────────────────────────────────────────────────

/** 引擎/provider 原生图片白名单（Rust agui.rs IMAGE_MIME_ALLOWLIST 同源） */
export const NATIVE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** 原生图片通道单图上限：base64 膨胀 4/3，+ 64MB POST 体上限留足余量。
 *  超过的图片退化为文件引用（read 工具读图），不静默丢。 */
export const NATIVE_IMAGE_MAX_BYTES = 24 * 1024 * 1024

/** 宿主 fs_read_data_url 的硬上限（fs.rs DATA_URL_MAX_BYTES） */
const FS_DATA_URL_MAX_BYTES = 16 * 1024 * 1024

/** 拖放文件落临时文件的单文件上限（IPC 传 base64，太大没有意义） */
const STAGE_MAX_BYTES = 48 * 1024 * 1024

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac']
const DOCUMENT_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'log', 'rtf', 'epub',
]
/** 文本类文档：引擎 `read` 工具可直接读取（提示词里明确说明） */
const TEXT_DOCUMENT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'log', 'tsv',
])

/** 原生选择器的文件类型分组（只列能发送的；不支持的类型选择器里不可见，
 *  拖放路径则进 add() 标成 error chip —— 都不静默丢） */
export const ATTACHMENT_DIALOG_FILTERS = [
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'heic', 'avif'] },
  { name: '视频', extensions: VIDEO_EXTENSIONS },
  { name: '音频', extensions: AUDIO_EXTENSIONS },
  { name: '文档', extensions: DOCUMENT_EXTENSIONS },
]

/** 扩展名 → MIME（file.type 为空 / 宿主 mime_for 不认识时兜底；
 *  仅用于分类与提示词展示，不改变引擎原生白名单判定） */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/jsonl',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  log: 'text/plain',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
}

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 && idx < name.length - 1 ? name.slice(idx + 1).toLowerCase() : ''
}

export function mimeForName(name: string): string {
  return EXT_MIME[extensionOf(name)] ?? ''
}

/** 声明 MIME 优先，但 `application/octet-stream` 视为"未知"——Windows 上
 *  很多文本/Office 文件会被浏览器/系统报成 octet-stream，此时按扩展名补。 */
export function resolveMime(name: string, declared?: string): string {
  const value = (declared ?? '').trim()
  if (value && value.toLowerCase() !== 'application/octet-stream') return value
  return mimeForName(name) || value
}

/** 文件 → 附件类别；`null` = 引擎/宿主都不支持（UI 标红，不发送） */
export function classifyAttachment(name: string, mime: string): AttachmentKind | null {
  const lower = (mime || mimeForName(name)).toLowerCase()
  const ext = extensionOf(name)
  if (lower.startsWith('image/') || (ext && EXT_MIME[ext]?.startsWith('image/'))) return 'image'
  if (lower.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext)) return 'video'
  if (lower.startsWith('audio/') || AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  if (lower.startsWith('text/') || DOCUMENT_EXTENSIONS.includes(ext)) return 'document'
  return null
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** 附件类别 → 中文短标签（chip/ARIA/提示词共用） */
export function attachmentKindLabel(kind: AttachmentKind | null | undefined): string {
  switch (kind) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'audio':
      return '音频'
    case 'document':
      return '文档'
    default:
      return '文件'
  }
}

/** data URL → {data: 纯 base64, mimeType}；白名单外/形状不符返回 null。
 *  FileReader 产物的 data 段可能含 `=` 填充与 `+`/`/`，这里只做形状校验。 */
export function parseImageDataUrl(url: string): PiImagePayload | null {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url)
  return m ? { mimeType: m[1]!, data: m[2]! } : null
}

// ── File ↔ 元数据（原生选择器构造的 File 没有字节；路径/大小走 WeakMap） ──

const fileMeta = new WeakMap<File, AttachmentMeta>()

export function setFileMeta(file: File, meta: AttachmentMeta): void {
  fileMeta.set(file, meta)
}

export function getFileMeta(file: File | undefined): AttachmentMeta | undefined {
  return file ? fileMeta.get(file) : undefined
}

/** 附件对象上的扩展字段（composer 附件来自 add() 的返回值；
 *  乐观/历史消息附件来自 convertTurnMessage 的映射）。 */
function attachmentMeta(att: Attachment): AttachmentMeta {
  const a = att as Attachment & AttachmentMeta
  const mime = resolveMime(att.name, a.mime ?? a.contentType ?? att.file?.type)
  return {
    kind: a.kind ?? classifyAttachment(att.name, mime) ?? undefined,
    mime,
    size: typeof a.size === 'number' ? a.size : att.file?.size,
    sourcePath: a.sourcePath,
    dataUrl: a.dataUrl,
  }
}

// ── 提示词（文件引用的唯一表述来源） ────────────────────────────────────────

/** 文件引用说明块：明确"不是原生多模态"，并给绝对路径与工具建议。
 *  二进制文档不承诺内置工具能解析（不假装能力）。 */
export function buildFileReferenceNote(files: readonly TurnAttachment[]): string {
  if (files.length === 0) return ''
  const lines = files.map((f) => {
    const shown = `${f.name}（${f.mime || '未知类型'}，${formatFileSize(f.size)}）`
    switch (f.kind) {
      case 'video':
        return `- 视频 ${shown}：本机绝对路径 ${f.path}。引擎不支持原生视频输入；如需检查请用 shell 工具（如 ffprobe/ffmpeg）读取该路径。`
      case 'audio':
        return `- 音频 ${shown}：本机绝对路径 ${f.path}。引擎不支持原生音频输入；如需处理请用 shell 工具读取该路径。`
      case 'document': {
        const ext = extensionOf(f.name)
        const textLike = TEXT_DOCUMENT_EXTENSIONS.has(ext)
        return textLike
          ? `- 文档 ${shown}：本机绝对路径 ${f.path}。可用 read 工具直接读取。`
          : `- 文档 ${shown}：本机绝对路径 ${f.path}。这是二进制文档，内置 read 工具无法解析；如需内容，可用 shell 工具尝试提取（如 PowerShell Expand-Archive 解 DOCX/XLSX/PPTX 的 XML、pdftotext 解 PDF）。工具不可用时请向用户说明，不要臆测内容。`
      }
      default:
        return `- 图片 ${shown}：本机绝对路径 ${f.path}。该图片未走原生图片通道（格式非白名单或超过大小上限），需用 read 工具读取。`
    }
  })
  return ['[附件] 用户随本消息提供了以下文件（不是原生多模态内容，可用工具读取）：', ...lines].join('\n')
}

/** 实际发给引擎的消息文本（显示文本可以只有附件，引擎要求 message 非空） */
export function composePrompt(
  text: string,
  imageNames: readonly string[],
  files: readonly TurnAttachment[],
): string {
  const blocks: string[] = []
  const trimmed = text.trim()
  if (trimmed) blocks.push(trimmed)
  if (files.length > 0) blocks.push(buildFileReferenceNote(files))
  if (!trimmed && imageNames.length > 0) {
    blocks.push(`[用户发送了 ${imageNames.length} 张图片：${imageNames.join('、')}，未附文字说明]`)
  }
  return blocks.join('\n\n')
}

/** 发送前把 assistant-ui 附件归一成两类载荷。
 *  任何不完整/不支持的附件都抛错（禁止半发/静默丢）。 */
export function collectAttachmentPlan(attachments: readonly Attachment[]): AttachmentPlan {
  const plan: AttachmentPlan = { images: [], imageDataUrls: [], imageNames: [], files: [] }
  for (const att of attachments) {
    if (att.status.type !== 'complete') {
      const reason =
        att.status.type === 'incomplete' && att.status.message
          ? `：${att.status.message}`
          : ''
      throw new Error(`附件 ${att.name} 未能发送${reason}`)
    }
    const meta = attachmentMeta(att)
    const mime = meta.mime ?? ''
    if (att.type === 'image') {
      const part = (att.content ?? []).find((p) => p.type === 'image')
      const image = part && part.type === 'image' ? part.image : undefined
      if (!image) throw new Error(`图片附件 ${att.name} 缺少数据，未发送`)
      const parsed = parseImageDataUrl(image)
      if (!parsed) throw new Error(`图片 ${att.name} 的格式（${mime || '未知'}）不在原生图片白名单（png/jpeg/webp/gif）`)
      plan.images.push(parsed)
      plan.imageDataUrls.push(image)
      plan.imageNames.push(att.name)
      continue
    }
    const kind = meta.kind ?? classifyAttachment(att.name, mime)
    if (!kind) throw new Error(`附件 ${att.name} 的类型不受支持，未发送`)
    if (!meta.sourcePath) throw new Error(`附件 ${att.name} 缺少本地路径，未发送`)
    plan.files.push({
      id: att.id,
      name: att.name,
      mime,
      size: meta.size ?? 0,
      path: meta.sourcePath,
      kind,
    })
  }
  return plan
}

// ── 适配器 ──────────────────────────────────────────────────────────────────

async function readFileDataUrl(file: File, signal?: AbortSignal): Promise<string> {
  if (typeof FileReader === 'undefined') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    const chunk = 32768
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const onAbort = () => {
      reader.abort()
      const err = new Error('附件读取已取消')
      err.name = 'AbortError'
      reject(err)
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    reader.onload = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(String(reader.result))
    }
    reader.onerror = () => {
      signal?.removeEventListener('abort', onAbort)
      reject(reader.error ?? new Error('附件读取失败'))
    }
    reader.readAsDataURL(file)
  })
}

/** 拖放的非图片文件：宿主没有文件路径（File 只有字节），落临时文件后引用 */
async function stageDroppedFile(file: File): Promise<string> {
  if (file.size === 0) throw new Error(`附件 ${file.name} 内容为空，未发送`)
  if (file.size > STAGE_MAX_BYTES) {
    throw new Error(
      `附件 ${file.name} 超过 ${formatFileSize(STAGE_MAX_BYTES)}，拖放模式无法发送——请用 + 按钮选择文件（保留本地路径）`,
    )
  }
  const dataUrl = await readFileDataUrl(file)
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error(`附件 ${file.name} 读取失败，未发送`)
  const path = await invoke<string>('attachment_stage', {
    name: file.name,
    dataBase64: dataUrl.slice(comma + 1),
  })
  // 宿主按扩展名落盘；prompt 里给出绝对路径，模型可自行探测格式
  return path
}

/**
 * 图片：原生通道（PNG/JPEG/WebP/GIF → data URL → POST images[]）。
 * 视频/音频/文档：complete + 空 content + sourcePath 元数据（prompt 引用）。
 * 不支持的类型：add() 直接返回 error 态（composer 里立即可见），send() 也
 * 再抛一次（防止有人绕过 add）。
 */
export class PiAttachmentAdapter implements AttachmentAdapter {
  /** 拖放放行全部类型，由 add() 分类并标红——若收窄，assistant-ui 会在
   *  `fileMatchesAccept` 处静默忽略（其 catch {} 吞错），用户看不到原因 */
  accept = '*'

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const stored = getFileMeta(file)
    const mime = resolveMime(file.name, stored?.mime || file.type)
    const kind = classifyAttachment(file.name, mime)
    const base = {
      id: generateId(),
      name: file.name,
      contentType: mime || undefined,
      file,
      ...(stored ?? {}),
    }
    if (!kind) {
      return {
        ...base,
        type: 'file',
        status: {
          type: 'incomplete',
          reason: 'error',
          message: `不支持的文件类型：${mime || extensionOf(file.name) || '未知'}`,
        },
      } as PendingAttachment
    }
    return {
      ...base,
      type: kind === 'image' ? 'image' : kind === 'document' ? 'document' : 'file',
      status: { type: 'requires-action', reason: 'composer-send' },
    } as PendingAttachment
  }

  async send(attachment: PendingAttachment, options?: { signal?: AbortSignal }): Promise<CompleteAttachment> {
    const stored = getFileMeta(attachment.file)
    const meta = attachmentMeta(attachment)
    const mime = resolveMime(
      attachment.name,
      stored?.mime ?? meta.mime ?? attachment.contentType ?? attachment.file?.type,
    )
    const kind = stored?.kind ?? meta.kind ?? classifyAttachment(attachment.name, mime)
    if (!kind) {
      throw new Error(`附件 ${attachment.name} 的类型（${mime || '未知'}）不受支持，未发送`)
    }
    const size = stored?.size ?? meta.size ?? attachment.file?.size ?? 0
    // 原生图片通道的前提是「拿得到图片字节」：选择器预读的 data URL，或
    // 拖放 File 的真实字节（且不超过单图上限）。>16MB 的选择器图片没有
    // 预读、File 是空壳；超大拖放图超过 24MB——两者都退化为文件引用
    // （read 工具读图），而不是报错/静默丢。
    const nativeData = stored?.dataUrl ?? meta.dataUrl
    const hasBytes = (attachment.file?.size ?? 0) > 0
    const withinNativeLimit = (attachment.file?.size ?? 0) <= NATIVE_IMAGE_MAX_BYTES

    if (
      kind === 'image' &&
      NATIVE_IMAGE_MIMES.has(mime) &&
      (nativeData || (hasBytes && withinNativeLimit))
    ) {
      let dataUrl = nativeData
      if (!dataUrl) {
        const file = attachment.file
        if (!file) throw new Error(`图片 ${attachment.name} 没有可读取的内容，未发送`)
        dataUrl = await readFileDataUrl(file, options?.signal)
      }
      if (!parseImageDataUrl(dataUrl)) {
        throw new Error(`图片 ${attachment.name} 的格式（${mime}）不在原生图片白名单（png/jpeg/webp/gif）`)
      }
      return {
        ...attachment,
        type: 'image',
        status: { type: 'complete' },
        content: [{ type: 'image', image: dataUrl }],
        kind,
        mime,
        size,
        ...(stored?.sourcePath ? { sourcePath: stored.sourcePath } : {}),
        dataUrl,
      } as CompleteAttachment
    }

    let path = stored?.sourcePath ?? meta.sourcePath
    if (!path) {
      const file = attachment.file
      if (!file) throw new Error(`附件 ${attachment.name} 缺少本地路径，未发送`)
      path = await stageDroppedFile(file)
    }
    return {
      ...attachment,
      type: kind === 'document' ? 'document' : 'file',
      status: { type: 'complete' },
      content: [],
      kind,
      mime,
      size,
      sourcePath: path,
    } as CompleteAttachment
  }

  async remove(): Promise<void> {
    // 无上传资源需要回收（文件引用指向用户/临时目录的既有文件）
  }
}

/** 模块级单例：adapter 实例稳定（runtime 每次渲染重建会让 composer 丢附件） */
export const piAttachmentAdapter: AttachmentAdapter = new PiAttachmentAdapter()

// ── 原生选择器 ──────────────────────────────────────────────────────────────

interface FsStat {
  name: string
  path: string
  size: number
  mime: string
}

/**
 * 「+」按钮：Tauri 原生文件选择器 → 绝对路径 → 构造 File 交 composer。
 *  - 图片：≤16MB 时预读 data URL（省一次 FileReader，且缩略图可用）。
 *  - 其它：空 File + WeakMap 元数据（字节不经过 JS，视频/大文档不炸内存）。
 * 失败一律抛错（调用方显示在 composer 内联错误里，不静默）。
 */
export async function pickAttachmentFiles(): Promise<File[]> {
  const picked = await openFileDialog({
    multiple: true,
    title: '选择附件',
    filters: ATTACHMENT_DIALOG_FILTERS,
  })
  const paths = typeof picked === 'string' ? [picked] : (picked ?? [])
  const out: File[] = []
  for (const path of paths) {
    const stat = await invoke<FsStat>('fs_stat', { path })
    const mime = resolveMime(stat.name, stat.mime)
    const kind = classifyAttachment(stat.name, mime)
    if (!kind) {
      throw new Error(`不支持的文件类型：${stat.name}（${mime || '未知类型'}）`)
    }
    const file = new File([], stat.name, { type: mime })
    const meta: AttachmentMeta = {
      kind,
      mime,
      size: stat.size,
      sourcePath: stat.path || path,
    }
    if (
      kind === 'image' &&
      NATIVE_IMAGE_MIMES.has(mime) &&
      stat.size <= FS_DATA_URL_MAX_BYTES
    ) {
      meta.dataUrl = await invoke<string>('fs_read_data_url', { path: stat.path || path })
    }
    setFileMeta(file, meta)
    out.push(file)
  }
  return out
}
