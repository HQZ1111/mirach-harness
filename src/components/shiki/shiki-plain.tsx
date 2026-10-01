// 纯文本替身：与高亮输出的 <pre class="shiki"> 同几何（块级 pre + code），
// 载入期间/失败降级时颜色缺席但排版不跳。React 转义载荷——铁律「永不
// innerHTML」，这里永不走 dangerouslySetInnerHTML。
export function PlainShiki({ code }: { code: string }) {
  return (
    <pre className="shiki" style={{ backgroundColor: 'transparent', margin: 0 }}>
      <code>{code}</code>
    </pre>
  )
}
