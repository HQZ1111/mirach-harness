/**
 * 语音会话的口语停止词判定（hermes lib/voice-stop-word.ts 的宿主移植，
 * 2026-11-12）。免提语音对话里，结束的自然方式是**说"停止"**——不判定
 * 的话停止词会被照常转写提交，会话永不结束。
 *
 * 刻意保守：只有**整句**都是停止语（可选带称呼前缀）才判定——"stop the
 * docker container" 这类包含 stop 的真实请求永不吞掉。
 *
 * 宿主适配（hermes 默认英文表 + `voice.stop_phrases` 配置覆盖）：宿主无
 * voice-prefs store，默认表 = hermes 英文表 + **中文等价词**（宿主用户
 * 语言是中文——STT 转写出的 "停止"/"再见" 必须同样生效，否则对宿主用户
 * 是坏面）+ 称呼前缀加 "mirach"。config 参数保留（测试注入用）。
 */

// 内置停止语（hermes STOP_PHRASES 英文表逐字 + 宿主中文等价）。
const STOP_PHRASES: readonly string[] = [
  'stop',
  'stop listening',
  'stop it',
  'stop please',
  'please stop',
  'stop stop',
  'that is all',
  "that's all",
  'never mind',
  'nevermind',
  'end conversation',
  'end the conversation',
  'goodbye',
  'good bye',
  'bye',
  'cancel',
  // 宿主中文等价（STT 转写常见形）
  '停止',
  '停止 listening',
  '请停止',
  '别说了',
  '就这样',
  '结束对话',
  '再见',
  '拜拜',
  '取消',
]

// 称呼前缀（hermes 表 + mirach）：剥离后再比核心短语。
const ADDRESS_PREFIXES: readonly string[] = [
  'hey hermes',
  'hey hermes,',
  'hey mirach',
  'hey mirach,',
  'hermes',
  'hermes,',
  'mirach',
  'mirach,',
  'ok',
  'okay',
  'hey',
  '好的',
  '喂',
]

// 归一：NFKC 组合（NFD "отбой" 与 NFC 短语相等）、小写、任意文字的标点
// 转空格（"停止。"）、空白折叠。转写与配置短语走同一函数——匹配保持
// 精确（只对标点不敏感）。
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripAddress(text: string): string {
  for (const prefix of ADDRESS_PREFIXES) {
    if (text === prefix) {
      // 裸称呼（"mirach"）本身不是停止命令。
      continue
    }

    if (text.startsWith(`${prefix} `)) {
      return text.slice(prefix.length + 1).trim()
    }
  }

  return text
}

const DEFAULT_PHRASES = STOP_PHRASES.map(normalize)

/** 整句是停止命令（可选带称呼）时为真；仅包含 stop 的实质请求恒假。
 *  config 供测试/未来配置面注入；宿主生产恒用默认表。 */
export function isVoiceStopCommand(
  transcript: string,
  config?: { mode: 'default' | 'disabled'; phrases?: string[] },
): boolean {
  if (!transcript) {
    return false
  }

  const phrases = config
    ? config.mode === 'disabled'
      ? null
      : (config.phrases?.map(normalize).filter((p) => p.length > 0) ?? DEFAULT_PHRASES)
    : DEFAULT_PHRASES

  if (phrases == null || phrases.length === 0) {
    return false
  }

  const normalized = normalize(transcript)

  if (!normalized) {
    return false
  }

  // 剥离称呼后匹配 + 原样匹配（裸 "stop" 无前缀也命中；"please stop"——
  // "please" 不是前缀——直接命中）。
  const candidates = new Set([normalized, stripAddress(normalized)])

  for (const candidate of candidates) {
    if (phrases.includes(candidate)) {
      return true
    }
  }

  return false
}
