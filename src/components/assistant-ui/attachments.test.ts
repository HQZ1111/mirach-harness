/**
 * 附件通道纯逻辑（attachments.ts）回归：
 *  - 类型分类 / MIME 推断 / 原生图片白名单
 *  - 提示词：文件引用必须给绝对路径、明确“不是原生多模态”、二进制文档
 *    不承诺内置工具能解析
 *  - 发送前归一：图片 → POST images[]，视频/音频/文档 → 文件引用，
 *    不完整/不支持 → 抛错（禁止半发）
 *  - adapter：不支持类型在 add() 就标 error（composer 可见）
 */
import { describe, expect, it } from 'vitest'

import {
  PiAttachmentAdapter,
  classifyAttachment,
  collectAttachmentPlan,
  composePrompt,
  formatFileSize,
  mimeForName,
  parseImageDataUrl,
  resolveMime,
} from './attachments'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const completeImage = (id: string, name: string, image = PNG_DATA_URL) =>
  ({
    id,
    type: 'image',
    name,
    contentType: 'image/png',
    status: { type: 'complete' },
    content: [{ type: 'image', image }],
    kind: 'image',
    mime: 'image/png',
    size: 10,
  }) as never

const completeFile = (
  id: string,
  name: string,
  kind: 'video' | 'audio' | 'document',
  mime: string,
  size: number,
) =>
  ({
    id,
    type: kind === 'document' ? 'document' : 'file',
    name,
    contentType: mime,
    status: { type: 'complete' },
    content: [],
    kind,
    mime,
    size,
    sourcePath: `C:\\work\\${name}`,
  }) as never

describe('classifyAttachment', () => {
  it('按 MIME 分类图片/视频/音频/文档', () => {
    expect(classifyAttachment('a.png', 'image/png')).toBe('image')
    expect(classifyAttachment('a.mp4', 'video/mp4')).toBe('video')
    expect(classifyAttachment('a.mp3', 'audio/mpeg')).toBe('audio')
    expect(classifyAttachment('a.pdf', 'application/pdf')).toBe('document')
    expect(classifyAttachment('a.md', 'text/markdown')).toBe('document')
  })

  it('MIME 缺失时按扩展名兜底', () => {
    expect(classifyAttachment('shot.JPEG', '')).toBe('image')
    expect(classifyAttachment('clip.mkv', 'application/octet-stream')).toBe('video')
    expect(classifyAttachment('notes.txt', 'application/octet-stream')).toBe('document')
  })

  it('未知类型返回 null（UI 标红，不发送）', () => {
    expect(classifyAttachment('setup.exe', 'application/x-msdownload')).toBeNull()
    expect(classifyAttachment('blob', '')).toBeNull()
  })
})

describe('mimeForName / formatFileSize / parseImageDataUrl', () => {
  it('扩展名 → MIME', () => {
    expect(mimeForName('a.png')).toBe('image/png')
    expect(mimeForName('a.docx')).toContain('wordprocessingml')
    expect(mimeForName('a.unknown')).toBe('')
  })

  it('octet-stream 视为未知，按扩展名补 MIME', () => {
    expect(resolveMime('a.md', 'application/octet-stream')).toBe('text/markdown')
    expect(resolveMime('a.png', 'application/octet-stream')).toBe('image/png')
    expect(resolveMime('a.bin', 'application/octet-stream')).toBe('application/octet-stream')
    expect(resolveMime('a.mp4', '')).toBe('video/mp4')
  })

  it('大小格式化', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })

  it('只接受引擎原生图片白名单', () => {
    expect(parseImageDataUrl(PNG_DATA_URL)).toEqual({
      mimeType: 'image/png',
      data: PNG_DATA_URL.split(',')[1],
    })
    expect(parseImageDataUrl('data:image/bmp;base64,AAAA')).toBeNull()
    expect(parseImageDataUrl('https://example.com/a.png')).toBeNull()
  })
})

describe('composePrompt', () => {
  it('文件引用给绝对路径并说明不是原生多模态', () => {
    const msg = composePrompt('看看这个视频', [], [
      { id: '1', name: 'demo.mp4', mime: 'video/mp4', size: 1024, path: 'C:\\tmp\\demo.mp4', kind: 'video' },
    ])
    expect(msg).toContain('看看这个视频')
    expect(msg).toContain('[附件]')
    expect(msg).toContain('不是原生多模态')
    expect(msg).toContain('C:\\tmp\\demo.mp4')
    expect(msg).toContain('不支持原生视频输入')
  })

  it('文本类文档说明可用 read 读取；二进制文档不承诺', () => {
    const text = composePrompt('', [], [
      { id: '1', name: 'a.md', mime: 'text/markdown', size: 1, path: 'C:\\a.md', kind: 'document' },
    ])
    expect(text).toContain('可用 read 工具直接读取')
    const binary = composePrompt('', [], [
      { id: '2', name: 'a.pdf', mime: 'application/pdf', size: 1, path: 'C:\\a.pdf', kind: 'document' },
    ])
    expect(binary).toContain('无法解析')
    expect(binary).not.toContain('可用 read 工具直接读取')
  })

  it('纯图片无文字：引擎 message 非空且不伪造用户文本', () => {
    const msg = composePrompt('', ['a.png', 'b.png'], [])
    expect(msg).toContain('2 张图片')
    expect(msg).toContain('未附文字说明')
  })
})

describe('collectAttachmentPlan', () => {
  it('图片 → base64 payload；文件 → TurnAttachment', () => {
    const plan = collectAttachmentPlan([
      completeImage('i1', 'a.png'),
      completeFile('f1', 'demo.mp4', 'video', 'video/mp4', 2048),
      completeFile('f2', 'spec.pdf', 'document', 'application/pdf', 300),
    ])
    expect(plan.images).toHaveLength(1)
    expect(plan.images[0]!.mimeType).toBe('image/png')
    expect(plan.imageDataUrls).toHaveLength(1)
    expect(plan.imageNames).toEqual(['a.png'])
    expect(plan.files.map((f) => f.name)).toEqual(['demo.mp4', 'spec.pdf'])
    expect(plan.files[0]!.path).toBe('C:\\work\\demo.mp4')
  })

  it('未完成的附件 → 抛错（整条不发）', () => {
    expect(() =>
      collectAttachmentPlan([
        {
          id: 'x',
          type: 'file',
          name: 'bad.exe',
          status: { type: 'incomplete', reason: 'error', message: '不支持的文件类型' },
          file: new File([], 'bad.exe'),
        } as never,
      ]),
    ).toThrow(/bad\.exe/)
  })

  it('文件引用缺路径 → 抛错（不提交空引用）', () => {
    expect(() =>
      collectAttachmentPlan([
        {
          id: 'x',
          type: 'file',
          name: 'a.mp4',
          contentType: 'video/mp4',
          status: { type: 'complete' },
          content: [],
          kind: 'video',
          size: 1,
        } as never,
      ]),
    ).toThrow(/缺少本地路径/)
  })
})

describe('PiAttachmentAdapter', () => {
  it('不支持的类型在 add() 阶段就标 error（composer 立即可见）', async () => {
    const adapter = new PiAttachmentAdapter()
    const att = await adapter.add({ file: new File([], 'setup.exe', { type: 'application/x-msdownload' }) })
    expect(att.status.type).toBe('incomplete')
    expect(att.status).toMatchObject({ reason: 'error' })
  })

  it('文档 add() 后 send() 产出 complete + 空 content + sourcePath', async () => {
    const adapter = new PiAttachmentAdapter()
    const file = new File([], 'notes.md', { type: 'text/markdown' })
    // 模拟原生选择器：路径/大小走元数据（File 本身没有字节）
    const { setFileMeta } = await import('./attachments')
    setFileMeta(file, { kind: 'document', mime: 'text/markdown', size: 1234, sourcePath: 'C:\\docs\\notes.md' })
    const pending = await adapter.add({ file })
    const complete = await adapter.send(pending)
    expect(complete.status.type).toBe('complete')
    expect(complete.content).toEqual([])
    expect((complete as unknown as { sourcePath: string }).sourcePath).toBe('C:\\docs\\notes.md')
    expect((complete as unknown as { size: number }).size).toBe(1234)
  })

  it('图片 send() 走原生 data URL 通道', async () => {
    const adapter = new PiAttachmentAdapter()
    const file = new File([], 'a.png', { type: 'image/png' })
    const { setFileMeta } = await import('./attachments')
    setFileMeta(file, { kind: 'image', mime: 'image/png', size: 10, sourcePath: 'C:\\a.png', dataUrl: PNG_DATA_URL })
    const pending = await adapter.add({ file })
    const complete = await adapter.send(pending)
    expect(complete.status.type).toBe('complete')
    expect(complete.content).toEqual([{ type: 'image', image: PNG_DATA_URL }])
  })

  it('非白名单图片格式不走原生通道（转文件引用）', async () => {
    const adapter = new PiAttachmentAdapter()
    const file = new File([], 'a.bmp', { type: 'image/bmp' })
    const { setFileMeta } = await import('./attachments')
    setFileMeta(file, { kind: 'image', mime: 'image/bmp', size: 10, sourcePath: 'C:\\a.bmp' })
    const pending = await adapter.add({ file })
    const complete = await adapter.send(pending)
    expect(complete.content).toEqual([])
    expect((complete as unknown as { kind: string }).kind).toBe('image')
    expect((complete as unknown as { sourcePath: string }).sourcePath).toBe('C:\\a.bmp')
  })

  it('白名单图片但取不到字节（>16MB 选择器未预读）→ 退化为文件引用，不报错', async () => {
    const adapter = new PiAttachmentAdapter()
    const file = new File([], 'huge.png', { type: 'image/png' })
    const { setFileMeta } = await import('./attachments')
    setFileMeta(file, { kind: 'image', mime: 'image/png', size: 20 * 1024 * 1024, sourcePath: 'C:\\huge.png' })
    const pending = await adapter.add({ file })
    const complete = await adapter.send(pending)
    expect(complete.content).toEqual([])
    expect((complete as unknown as { sourcePath: string }).sourcePath).toBe('C:\\huge.png')
  })
})
