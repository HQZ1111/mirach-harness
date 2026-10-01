//! 终端 PTY 桥（宿主自建）——pi SDK 没有 PTY 面（bash 是工具内部 exec，
//! 不外露），真终端的进程侧在这里：portable-pty（Windows=ConPTY/Unix=pty）
//! + 会话注册表 + 两条推送线程（输出泵 / 退出监听）。
//!
//! 【事件通道裁定】终端输出/退出走 **Tauri Event**（`terminal-output:{id}` /
//! `terminal-exit:{id}`），控制面仍走 IPC invoke。这不违反 AG-UI 三通道
//! 纪律（docs/pi-integration.md §2.1）：AG-UI 只管 **Agent 数据**（事件流
//! 进轮次机），终端是系统设施不是 Agent 数据——塞进 AG-UI 环形缓冲反而
//! 会污染轮次归约。Tauri Event 正是 Tauri 为这类"宿主→前端"推送预留的
//! 通道（权限在 core:default 自带的 core:event:default 里）。
//!
//! 【生命周期】spawn = 登记 + ConPTY 打开 + 两个 detached 线程（输出泵
//! 读 PTY→事件；wait 线程阻塞等子进程退出→摘除登记→上报退出码）。
//! kill = ChildKiller.kill()，退出码由 wait 线程统一上报（kill 自身不
//! 编造退出码）。进程退出 = TerminalRegistry::drop 兜底全部 kill（Drop
//! 无法传播——规矩 12 的既注例外）；窗格关闭由前端 unmount 钩子逐个 kill。
//!
//! 【cwd 裁定】pi_get_state 没有 cwd 能力（PiEngine::state 只回
//! sessionId/provider/modelId/thinkingLevel/messageCount；SessionOptions
//! 未设 cwd，pi 的会话 cwd 从未进状态面），fs.rs 亦无 cwd 来源——故取
//! **系统 home**（Windows USERPROFILE / Unix HOME；取不到 = Err 传播）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// 会话数上限：防失控（每会话 = 一个 shell 进程 + 两条线程）。
/// 超出 spawn 明确 Err——不静默挤掉旧会话。
const MAX_SESSIONS: usize = 8;

/// 输出泵单次读块（PTY 输出是逐段到达的流，块大小只影响事件粒度）
const READ_CHUNK: usize = 8192;

/// 单个终端会话的进程侧句柄。三个字段各带自己的 Mutex：写/改尺寸/杀
/// 是三条独立 IPC 路径，互不阻塞（registry 锁只护 HashMap 的取放）。
struct SessionHandle {
    /// shell stdin（terminal_write 走这里）
    writer: Mutex<Box<dyn Write + Send>>,
    /// PTY 主端（terminal_resize 走这里）
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// 杀手（terminal_kill / Drop 清场走这里）——child 本体已交给 wait
    /// 线程阻塞 wait，杀进程只经 killer
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
struct RegistryInner {
    sessions: HashMap<u32, Arc<SessionHandle>>,
    next_id: u32,
}

impl RegistryInner {
    /// 容量检查 + 分配 id（纯逻辑，单测覆盖）。
    fn alloc_id(&mut self) -> Result<u32, String> {
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(format!("终端会话数已达上限（{MAX_SESSIONS}），请先关闭不用的终端"));
        }
        self.next_id += 1;
        Ok(self.next_id)
    }
}

/// 终端会话注册表（main.rs manage；命令经 State<Arc<TerminalRegistry>> 取）。
pub struct TerminalRegistry(Mutex<RegistryInner>);

impl TerminalRegistry {
    pub fn new() -> Self {
        Self(Mutex::new(RegistryInner::default()))
    }

    /// 短暂取锁登记（返回会话句柄的 Arc，锁即释——后续 write/resize/kill
    /// 各自锁会话自己的 Mutex，一条写满的 PTY 不会拖住整个注册表）。
    fn insert(&self, id: u32, handle: Arc<SessionHandle>) -> Result<(), String> {
        let mut inner = self
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner.sessions.insert(id, handle);
        Ok(())
    }

    /// 短暂取锁摘除（wait 线程在子进程退出后调用——drop 最后的 Arc 释放
    /// writer/master，PTY 关闭，输出泵线程随之 EOF 退出）。
    fn remove(&self, id: u32) -> Result<(), String> {
        let mut inner = self
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner.sessions.remove(&id);
        Ok(())
    }
}

/// 应用退出清场：全部会话尽力 kill。Drop 无法传播错误（规矩 12 既注
/// 例外），kill 失败只留日志。
impl Drop for TerminalRegistry {
    fn drop(&mut self) {
        let Ok(inner) = self.0.lock() else {
            eprintln!("[terminal] registry mutex poisoned at drop, skipping cleanup");
            return;
        };
        for (id, handle) in inner.sessions.iter() {
            match handle.killer.lock() {
                Ok(mut killer) => {
                    if let Err(e) = killer.kill() {
                        eprintln!("[terminal:{id}] kill at drop failed: {e}");
                    }
                }
                Err(_) => eprintln!("[terminal:{id}] killer mutex poisoned at drop"),
            }
        }
    }
}

// ── 默认值裁定 ───────────────────────────────────────────────────────────────

/// 默认 shell：Windows = PowerShell（用户定稿；powershell.exe 系统自带，
/// 不猜 pwsh 是否安装）；Unix = $SHELL，缺省 bash（环境变量缺失是配置
/// 事实而非错误，注释裁定）。
fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// 终端 cwd = 系统 home（裁定见模块头【cwd 裁定】）。取不到/非目录 = Err。
fn default_cwd() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    let raw = std::env::var_os(key).ok_or_else(|| format!("home 目录不可用（{key} 未设置）"))?;
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err(format!("home 目录不可用（{key} 非目录: {}）", path.display()));
    }
    Ok(path)
}

// ── 事件载荷 ─────────────────────────────────────────────────────────────────

/// 输出事件载荷：data = PTY 原始字节的 base64。不用字符串直接推——
/// 一次 read 可能劈开多字节 UTF-8 序列，base64 保字节完整性，前端用
/// 流式 TextDecoder 还原。（Clone：tauri Emitter::emit 的载荷约束）
#[derive(Clone, Serialize)]
struct TerminalOutputEvent {
    id: u32,
    data: String,
}

/// 退出事件载荷：exit_code 缺 = wait 本身失败（error 说明原因）。
/// 唯一上报通道就是这条事件（线程深处无调用方可返 Err）——失败也走这里。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    id: u32,
    exit_code: Option<u32>,
    error: Option<String>,
}

/// spawn 结果：shell 原串给前端做页签名（ZCode formatShellLabel 同源）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    id: u32,
    shell: String,
    cwd: String,
}

// ── 命令（全部 async：同步 fn 走 Tauri 线程池，风格照抄 pi_* 命令） ─────────

#[tauri::command(async)]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<Arc<TerminalRegistry>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<Spawned, String> {
    // 容量检查前置：超限就不开 PTY（开了再拒会漏孤儿进程）
    let id = {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner.alloc_id()?
    };

    let cwd = default_cwd()?;
    let shell = default_shell();

    // 初始尺寸：前端先 fit 再 spawn（ZCode 同款时序，避免启动输出按错
    // 宽度重排）；缺省 80×24 只是 PTY 协议初值，前端随后必 resize。
    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("PTY 打开失败: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("shell 启动失败（{shell}）: {e}"))?;
    // slave 用完即弃：Unix 上不 drop 会顶住会话端 EOF（portable-pty 示例同款）
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("PTY writer 获取失败: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("PTY reader 获取失败: {e}"))?;
    let killer = child.clone_killer();

    state.insert(
        id,
        Arc::new(SessionHandle {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
        }),
    )?;

    // 输出泵：读 PTY → terminal-output:{id}。EOF（子进程退出/PTY 关闭）
    // 或事件通道失效（应用退出中）即收线；wait 线程负责退出上报。
    let app_pump = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let event = TerminalOutputEvent {
                        id,
                        data: base64::engine::general_purpose::STANDARD.encode(&buf[..n]),
                    };
                    if let Err(e) = app_pump.emit(&format!("terminal-output:{id}"), event) {
                        eprintln!("[terminal:{id}] output emit failed: {e}");
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[terminal:{id}] read failed: {e}");
                    break;
                }
            }
        }
    });

    // wait 线程：阻塞到子进程退出 → 摘除登记（释放 PTY）→ 上报退出码。
    let registry = state.inner().clone();
    let app_wait = app;
    std::thread::spawn(move || {
        let status = child.wait();
        if let Err(e) = registry.remove(id) {
            eprintln!("[terminal:{id}] registry remove failed: {e}");
        }
        let (exit_code, error) = match status {
            Ok(s) => (Some(s.exit_code()), None),
            Err(e) => (None, Some(format!("PTY wait 失败: {e}"))),
        };
        let event = TerminalExitEvent {
            id,
            exit_code,
            error,
        };
        eprintln!(
            "[terminal:{id}] exited (code {:?}, error {:?})",
            event.exit_code, event.error
        );
        // emit 失败 = 无接收方（应用退出中）——无处可报，留日志
        if let Err(e) = app_wait.emit(&format!("terminal-exit:{id}"), event) {
            eprintln!("[terminal:{id}] exit emit failed: {e}");
        }
    });

    Ok(Spawned {
        id,
        shell,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

#[tauri::command(async)]
pub fn terminal_write(state: State<Arc<TerminalRegistry>>, id: u32, data: String) -> Result<(), String> {
    let handle = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner
            .sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("终端会话 {id} 不存在"))?
    };
    // registry 锁已释：写阻塞只影响本会话
    let mut writer = handle
        .writer
        .lock()
        .map_err(|_| format!("终端会话 {id} writer mutex poisoned"))?;
    writer
        .write_all(data.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|e| format!("写入终端会话 {id} 失败: {e}"))
}

#[tauri::command(async)]
pub fn terminal_resize(
    state: State<Arc<TerminalRegistry>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handle = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner
            .sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("终端会话 {id} 不存在"))?
    };
    let master = handle
        .master
        .lock()
        .map_err(|_| format!("终端会话 {id} master mutex poisoned"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端会话 {id} 尺寸失败: {e}"))
}

/// 杀会话：kill 本身不编造退出码——实际退出（含退出码）由 wait 线程经
/// terminal-exit:{id} 上报。会话已不存在 = Err（前端只对自己还持有的
/// 页签调 kill，正常流程不会撞上）。
#[tauri::command(async)]
pub fn terminal_kill(state: State<Arc<TerminalRegistry>>, id: u32) -> Result<(), String> {
    let handle = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner
            .sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("终端会话 {id} 不存在"))?
    };
    let mut killer = handle
        .killer
        .lock()
        .map_err(|_| format!("终端会话 {id} killer mutex poisoned"))?;
    killer.kill().map_err(|e| format!("终止终端会话 {id} 失败: {e}"))
}

/// 系统默认浏览器打开终端里的 http(s) 链接（ZCode onOpenBrowserUrl 的
/// 宿主等价物；失败 = Err 传播，前端可见）。
#[tauri::command(async)]
pub fn terminal_open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("只允许打开 http(s) 链接，收到: {url}"));
    }
    open::that(&url).map_err(|e| format!("打开链接失败（{url}）: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// id 注册表纯逻辑：顺序分配；容量上限明确 Err；摘除释放容量。
    #[test]
    fn alloc_id_enforces_cap_and_reuse_of_capacity() {
        let mut inner = RegistryInner::default();
        let mut ids = Vec::new();
        for _ in 0..MAX_SESSIONS {
            let id = inner.alloc_id().expect("cap not reached yet");
            inner.sessions.insert(id, Arc::new(SessionHandle {
                writer: Mutex::new(Box::new(std::io::sink())),
                master: Mutex::new(unreachable_master()),
                killer: Mutex::new(Box::new(NoKill)),
            }));
            ids.push(id);
        }
        // 打满：明确 Err，不挤旧会话
        assert!(inner.alloc_id().is_err());
        // id 单调递增
        assert_eq!(ids, (1..=MAX_SESSIONS as u32).collect::<Vec<_>>());
        // 摘除一个 → 容量释放，能再分配且 id 不复用
        inner.sessions.remove(&ids[0]);
        let next = inner.alloc_id().expect("freed slot allows alloc");
        assert_eq!(next, (MAX_SESSIONS + 1) as u32);
    }

    // ── 测试替身：SessionHandle 的字段必须装箱 trait 对象，注册表纯逻辑
    //    测试用 no-op 实现填充（PTY 真身只在 spawn 路径出现）。

    #[derive(Debug)]
    struct NoKill;
    impl ChildKiller for NoKill {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(NoKill)
        }
    }

    fn unreachable_master() -> Box<dyn MasterPty + Send> {
        // MasterPty 无空实现——用 openpty 造真身（测试进程内开一个 PTY
        // 开销可忽略），测试本身只碰 HashMap 不碰 master
        native_pty_system()
            .openpty(PtySize {
                rows: 2,
                cols: 2,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty in test")
            .master
    }
}
