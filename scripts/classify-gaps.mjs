// 最终分类：22 个未接 RPC 逐个定性
const items = [
  // 事件（host → plugin 推送，走 Tauri emit + host.onEvent，不走 host-rpc dispatch）
  { name: 'bot_relay.outbox.pending', type: 'event', note: 'Rust emit → Tauri event → host.onEvent（push drain 触发器）' },
  { name: 'gateway.ready', type: 'event', note: 'main.rs setup emit（本地网关恒就绪）' },
  { name: 'groups.changed', type: 'event', note: 'pi_groups groups_dispatch 成功后 emit' },
  { name: 'message.complete', type: 'event', note: 'bot 泳道生产 → Tauri event' },
  { name: 'session.reclaimed', type: 'event', note: 'pi_delete_session emit（本轮新接）' },
  { name: 'tool.start', type: 'event', note: 'pi_bot tool pump emit' },
  { name: 'display.install.done', type: 'event', note: 'hermes 远程桌面安装完成事件（宿主无安装流程）' },
  { name: 'display.install.log', type: 'event', note: 'hermes 远程桌面安装日志事件（宿主无安装流程）' },
  // 消息事件（存 hosted_room_events，前端轮询 / driver 写回）
  { name: 'message.member', type: 'room_event', note: 'canonical 房间日志事件（driver 写回）' },
  { name: 'message.user', type: 'room_event', note: 'canonical 房间日志事件（groups.send 写入）' },
  // i18n key（不是 RPC）
  { name: 'cron.deliverLabel', type: 'i18n', note: 'cron UI 的投递标签 key' },
  { name: 'cron.modelLabel', type: 'i18n', note: 'cron UI 的模型标签 key' },
  { name: 'cron.scheduleLabels.daily', type: 'i18n', note: 'cron UI 的调度标签 key' },
  { name: 'cron.scheduleLabels.hourly', type: 'i18n', note: 'cron UI 的调度标签 key' },
  { name: 'cron.title', type: 'i18n', note: 'cron UI 的标题 key' },
  // 数据形状（不是 RPC 方法）
  { name: 'display.lease', type: 'shape', note: 'display lease 对象（observe 返回的字段）' },
  { name: 'groups.peer.invite.status_ttl_seconds', type: 'param', note: 'groups.peer.invite 的参数名字符串' },
  // hermes 架构特有面
  { name: 'groups.peer.invite', type: 'hermes_only', note: 'lending 网关的 WS invite 方法（宿主用 pi_peer HTTP 面替代）' },
  { name: 'groups.demote', type: 'hermes_only', note: 'hermes multi-profile 降级操作（宿主单 profile）' },
  { name: 'groups.promote', type: 'hermes_only', note: 'hermes multi-profile 升级操作（宿主单 profile）' },
  { name: 'groups.replica_state', type: 'hermes_only', note: 'hermes multi-gateway replica 状态（宿主单机）' },
  { name: 'groups.replicate', type: 'hermes_only', note: 'hermes multi-gateway replica 复制（宿主单机）' },
  { name: 'display.install', type: 'hermes_only', note: 'hermes 远程桌面安装（宿主=本机屏幕，无远程安装语义）' },
]
const events = items.filter(i => i.type === 'event' || i.type === 'room_event')
const i18n = items.filter(i => i.type === 'i18n')
const shapes = items.filter(i => i.type === 'shape' || i.type === 'param')
const hermesOnly = items.filter(i => i.type === 'hermes_only')
console.log(`事件（Tauri emit → onEvent，不走 host-rpc case）: ${events.length}`)
console.log(`i18n key（UI 标签，不是 RPC）: ${i18n.length}`)
console.log(`数据形状/参数名（不是方法）: ${shapes.length}`)
console.log(`hermes 架构特有面（需要特定后端基础设施）: ${hermesOnly.length}`)
console.log('--- hermes only ---')
hermesOnly.forEach(i => console.log(`  ${i.name}: ${i.note}`))
