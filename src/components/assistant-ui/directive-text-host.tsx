/**
 * 用户消息文本的 directive 渲染（2026-11-28）。
 *
 * 组件本体 = assistant-ui 官方元素 `elements/directive-text`（跟 aui 上游走，
 * 不自己维护）；本文件只是宿主 glue：
 *  - formatter 两段：官方 `unstable_defaultDirectiveFormatter`（`:type[label]{name=id}`
 *    语法）原样透传；纯文本段里再把 `@token` 切成 mention chip——与 composer
 *    的 `applyMentionRow` 同一字符集（字母数字 + `-` `.` `@`），且要求前导为
 *    空白/行首（`user@example.com` 这类邮箱不会误判成 chip）。
 *  - 管理/挂载抄 hermes：她那边 rich-editor 把 mention 序列化成 directive
 *    chip、气泡里再渲染回 chip；宿主没有 RichEditor，最小对偶 = 发送文本里的
 *    `@name` 在气泡里显示为 chip。
 */
import type { FC } from 'react'
import { AtSignIcon } from 'lucide-react'
import { unstable_defaultDirectiveFormatter } from '@assistant-ui/react'

import {
  createDirectiveText,
  type DirectiveTextFormatter,
  type DirectiveTextSegment,
} from './elements/directive-text'

/** 前导必须是行首或空白；token 字符集与 composer mention 一致。 */
const MENTION_RE = /(^|\s)@([\w@.-]+)/g

export const mirachDirectiveFormatter: DirectiveTextFormatter = {
  parse(text: string): readonly DirectiveTextSegment[] {
    const out: DirectiveTextSegment[] = []
    for (const seg of unstable_defaultDirectiveFormatter.parse(text)) {
      if (seg.kind !== 'text') {
        out.push(seg)
        continue
      }
      let last = 0
      for (const match of seg.text.matchAll(MENTION_RE)) {
        const at = match.index! + match[1].length
        if (at > last) out.push({ kind: 'text', text: seg.text.slice(last, at) })
        out.push({ kind: 'mention', type: 'mention', label: `@${match[2]}`, id: match[2] })
        last = at + match[0].length - match[1].length
      }
      if (last < seg.text.length) out.push({ kind: 'text', text: seg.text.slice(last) })
    }
    return out
  },
}

export const UserDirectiveText: FC<{ text: string }> = createDirectiveText(
  mirachDirectiveFormatter,
  { fallbackIcon: AtSignIcon },
)
