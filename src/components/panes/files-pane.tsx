import { PlaceholderPane } from './placeholder-pane'

export function FilesPane() {
  return (
    <PlaceholderPane
      title="文件树"
      description="右栏：项目文件树占位。"
      hints={['目录浏览 + 预览读图（fs.rs 命令已就绪）']}
    />
  )
}
