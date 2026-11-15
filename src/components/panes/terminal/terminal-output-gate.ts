/**
 * 终端输出装配器：PTY 字节块 → 可写进 xterm 的文本，且**顺序不依赖 IPC
 * 到达顺序**。
 *
 * 为什么需要 gate（对齐 ZCode createBufferedTerminalOutputEmitter 的
 * 语义，前端侧等价物）：
 * - attach 之前的输出在宿主 backlog 里（terminal.rs OutputState）；
 * - attach 之后的输出走 terminal-output 事件；
 * - 两者在 IPC 层没有全局顺序保证——attach 的 invoke 回包和最早几条事件
 *   可能任意先后抵达 webview。
 * 所以事件先排队，`attachBacklog` 回放 backlog 后再按序放行排队块；
 * 放行之后的块直接解码。UTF-8 解码器全程 stream:true，多字节序列被
 * IPC 边界劈开也能还原（中文输出不乱码）。
 */

export class TerminalOutputGate {
  private readonly decoder = new TextDecoder('utf-8')
  private opened = false
  private queued: Uint8Array[] = []

  /** 事件通道来一块：attach 完成前只排队（返回空串，不写屏幕）。 */
  push(bytes: Uint8Array): string {
    if (!this.opened) {
      this.queued.push(bytes)
      return ''
    }
    return this.decoder.decode(bytes, { stream: true })
  }

  /** attach 回包：先回放 backlog，再按到达顺序放行排队的事件块。 */
  attachBacklog(bytes: Uint8Array): string {
    this.opened = true
    let text = bytes.length > 0 ? this.decoder.decode(bytes, { stream: true }) : ''
    const queued = this.queued
    this.queued = []
    for (const chunk of queued) {
      text += this.decoder.decode(chunk, { stream: true })
    }
    return text
  }

  /** 会话结束：放行排队块 + 冲掉解码器里悬挂的多字节尾巴。 */
  finish(): string {
    this.opened = true
    const queued = this.queued
    this.queued = []
    let text = ''
    for (const chunk of queued) {
      text += this.decoder.decode(chunk, { stream: true })
    }
    // decode() 无入参 = flush：不完整的序列输出替换字符而不是永久滞留
    return text + this.decoder.decode()
  }
}
