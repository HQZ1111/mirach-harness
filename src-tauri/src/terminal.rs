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
//! 【页面归属与孤儿回收（2026-11-18）】会话登记带页面归属（webview label +
//! 页面 token，前端 terminal-pty.ts 生成）。**页面 reload（dev HMR / webview
//! 重启）后旧页面的 kill 钩子随页面消失**，遗留 PTY 会一直活着——此前的
//! 8 条会话上限就是这么被打满的（用户报"显示达到上限 8 无法打开"）。
//! 修法 = 新页面加载时 `terminal_reap(label, token)` 回收同 label 下旧
//! token 的会话（spawn 内也兜一遍）；会话数上限随之撤除（ZCode 不设上限）。
//! **无上限不是无限兜底**：泄漏源已由 reap 关闭，界面上的每个标签仍是
//! 一个显式会话。
//!
//! 【首屏输出不能丢（2026-11-15，对齐 ZCode createBufferedTerminalOutputEmitter）】
//! spawn 与前端 `listen()` 之间存在真实窗口：`terminal_spawn` 一返回就
//! 起输出泵，而前端还要等 invoke 回包 + `listen` 两次 IPC 才拿得到事件。
//! Tauri Event 在无监听者时**直接丢弃**——shell 的 banner/首个提示符正好
//! 落在窗口里就是"终端开了但一片空白"。修法 = 宿主侧有界缓冲 + 显式
//! attach：未 attach 的会话把输出存 backlog（上限 BACKLOG_MAX_BYTES，超了
//! 丢最旧块——与 ZCode 的 1MB 策略同值，是内存上界策略不是错误兜底），
//! 前端先订阅事件再 `terminal_attach`：返回 backlog 一次性回放，此后输出
//! 走事件。**未 attach 就退出的会话**同理靠 attach 回放 exit——否则前端
//! 错过退出事件，页签会永远停在"运行中"（死会话假活）。
//!
//! 【shell 裁定】同 ZCode resolveTerminalShell：Windows 依次
//! pwsh.exe → powershell.exe → ComSpec → cmd.exe（每个都验可执行；
//! PSReadLine 在 5.1 下更容易把输入行空白重绘成 ANSI black，故优先 pwsh）；
//! Unix 依次 $SHELL → /bin/zsh → /bin/bash → /bin/sh。全部不可用 = Err。
//!
//! 【cwd 裁定】前端传**当前会话的工作区**（sessionCatalog 的 active 条目
//! cwd，ZCode 同源语义：terminalService.create({cwd}) 用 workspace 路径）。
//! 传了但不是目录 = Err 传播（规矩 12：不静默回退到 home——用户会看到
//! "终端启动失败: 工作区目录不可用 …"，比开在别处假装成功好）。不传
//! （无活动会话/会话没选工作区）才取系统 home（USERPROFILE/HOME）。
//!
//! 【env 裁定】对齐 ZCode resolveTerminalEnv：TERM=xterm-256color、
//! COLORTERM 缺省 truecolor（父进程 inherit 其余变量——portable-pty 的
//! CommandBuilder 以 get_base_env() 起底，PATH 不会被清空）。

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// 输出泵单次读块（PTY 输出是逐段到达的流，块大小只影响事件粒度）
const READ_CHUNK: usize = 8192;

/// 未 attach 期间的输出缓冲上限（字节）。与 ZCode
/// TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS 同值：超出丢**最旧**的整块
/// （屏幕上最可能还可见的是尾部输出）。这是内存上界策略，不是错误兜底。
const BACKLOG_MAX_BYTES: usize = 1_048_576;

/// 单个终端会话的进程侧句柄。四个字段各带自己的 Mutex：写/改尺寸/杀/
/// 输出缓冲是四条独立路径，互不阻塞（registry 锁只护 HashMap 的取放）。
struct SessionHandle {
    /// shell stdin（terminal_write 走这里）
    writer: Mutex<Box<dyn Write + Send>>,
    /// PTY 主端（terminal_resize 走这里）
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// 杀手（terminal_kill / Drop 清场走这里）——child 本体已交给 wait
    /// 线程阻塞 wait，杀进程只经 killer
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// 输出泵 ↔ 前端 attach 的交接面（backlog + 退出补发，见模块头）
    output: Mutex<OutputState>,
}

/// 输出缓冲 / attach 状态（纯逻辑，单测覆盖）。
#[derive(Default)]
struct OutputState {
    /// 前端已 attach：此后输出直接走事件，不再进 backlog
    attached: bool,
    backlog: VecDeque<Vec<u8>>,
    backlog_bytes: usize,
    /// 会话已退出时的退出信息。attach 晚于退出时靠它补发（事件已错过）
    exited: Option<ExitInfo>,
}

impl OutputState {
    /// 输出泵单块交接：未 attach = 入 backlog（返回 false，不要 emit）；
    /// 已 attach = 返回 true（调用方 emit）。
    fn offer(&mut self, chunk: Vec<u8>) -> bool {
        if self.attached {
            return true;
        }
        self.backlog_bytes += chunk.len();
        self.backlog.push_back(chunk);
        // 至少留一块：单块超过上限时也保留它（丢一块 8KB 的实时输出
        // 比留超限更糟——上限约束的是累积量）
        while self.backlog_bytes > BACKLOG_MAX_BYTES && self.backlog.len() > 1 {
            match self.backlog.pop_front() {
                Some(dropped) => self.backlog_bytes -= dropped.len(),
                None => break,
            }
        }
        false
    }

    /// attach：置位 + 取走 backlog（顺序拼接成一块，前端一次流式解码）。
    fn attach(&mut self) -> Vec<u8> {
        self.attached = true;
        let mut out = Vec::with_capacity(self.backlog_bytes);
        for chunk in self.backlog.drain(..) {
            out.extend_from_slice(&chunk);
        }
        self.backlog_bytes = 0;
        out
    }
}

#[derive(Default)]
struct RegistryInner {
    sessions: HashMap<u32, Arc<SessionHandle>>,
    /// 会话所有权（id → 页面归属）。页面 reload（dev HMR / webview 重启）
    /// 后旧页面的 kill 钩子随页面消失，遗留的 PTY 永远无人认领——新页面
    /// 用同一 label 但新 token 的 `terminal_reap` 回收它们（见 reap 命令）。
    owners: HashMap<u32, SessionOwner>,
    next_id: u32,
}

/// 页面归属：webview label + 页面 token（前端 `terminal-pty.ts` 生成，
/// 每次页面加载一个新值；HMR 重挂不换）。
#[derive(Clone, PartialEq, Eq, Debug)]
struct SessionOwner {
    label: String,
    token: String,
}

impl RegistryInner {
    /// 分配 id：单调递增，**不复用**（旧页面迟到的 kill/attach 不会误伤
    /// 新会话；ZCode 的 session id 同语义）。
    ///
    /// 无会话数上限（2026-11-18 用户报"上限 8 打不开"）。ZCode 同样不设
    /// 上限；此前的 8 上限是在泄漏真因（页面 reload 遗留会话）未解决时的
    /// 止血，解掉泄漏后按上游对齐撤除。
    fn alloc_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    /// 该页面（label）下 token 不是当前的会话 = 上一代页面遗留的孤儿。
    /// 纯逻辑（单测覆盖）。
    fn stale_sessions_for(&self, owner: &SessionOwner) -> Vec<u32> {
        let mut ids: Vec<u32> = self
            .owners
            .iter()
            .filter(|(_, o)| o.label == owner.label && o.token != owner.token)
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        ids
    }
}

/// 尽力终止一个会话。**返回值不可信**：portable-pty 0.8.1 的
/// `WinChildKiller::kill` 把成功判定写反了（`if res != 0 { Err }`，
/// 而 TerminateProcess 是"非 0 = 成功"）——Windows 上每次成功 kill 都会
/// 返回 Err（带上一次调用的陈旧 errno，曾日志成"句柄无效 os error 6"）。
/// 真正的结果由 wait 线程观察：进程退出 → 摘除登记 + 上报 exit 事件。
fn kill_session(id: u32, handle: &Arc<SessionHandle>) {
    match handle.killer.lock() {
        Ok(mut killer) => {
            if let Err(e) = killer.kill() {
                eprintln!(
                    "[terminal:{id}] kill returned Err ({e})——portable-pty 0.8.1 的 Windows \
                     返回值反了，是否真正终止以 exit 事件为准"
                );
            }
        }
        Err(_) => eprintln!("[terminal:{id}] killer mutex poisoned, kill skipped"),
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
    fn insert(&self, id: u32, owner: SessionOwner, handle: Arc<SessionHandle>) -> Result<(), String> {
        let mut inner = self
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner.owners.insert(id, owner);
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
        inner.owners.remove(&id);
        Ok(())
    }
}

/// 回收同一窗口上一代页面遗留的会话（kill 后由 wait 线程统一摘登记）。
/// 纯读登记 + 逐个 kill，registry 锁不跨 kill 持有。
fn reap_stale_sessions(
    state: &State<Arc<TerminalRegistry>>,
    owner: &SessionOwner,
) -> Result<usize, String> {
    let stale = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner.stale_sessions_for(owner)
    };
    let mut reaped = 0;
    for id in stale {
        let handle = {
            let inner = state
                .0
                .lock()
                .map_err(|_| "terminal registry mutex poisoned".to_string())?;
            inner.sessions.get(&id).cloned()
        };
        if let Some(handle) = handle {
            eprintln!("[terminal:{id}] reaping stale session from previous page load");
            kill_session(id, &handle);
            reaped += 1;
        }
    }
    Ok(reaped)
}

/// 回收本窗口上一代页面遗留的终端会话（2026-11-18：用户报"上限 8 打不开"
/// 的根因——页面 reload（dev HMR / webview 重启）后旧页面发不出 kill，
/// 遗留 PTY 占满注册表）。页面加载时由前端调用一次；spawn 内也会兜一遍。
/// 返回被回收的会话数。
#[tauri::command(async)]
pub fn terminal_reap(
    state: State<Arc<TerminalRegistry>>,
    owner_label: String,
    owner_token: String,
) -> Result<usize, String> {
    reap_stale_sessions(
        &state,
        &SessionOwner {
            label: owner_label,
            token: owner_token,
        },
    )
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
            kill_session(*id, handle);
        }
    }
}

// ── shell / cwd 裁定 ─────────────────────────────────────────────────────────

/// shell 候选序列（ZCode resolveTerminalShell 同序，2026-11-15 对齐）。
#[cfg(windows)]
fn shell_candidates() -> Vec<String> {
    let mut candidates = vec!["pwsh.exe".to_string(), "powershell.exe".to_string()];
    if let Ok(comspec) = std::env::var("ComSpec") {
        if !comspec.trim().is_empty() {
            candidates.push(comspec);
        }
    }
    candidates.push("cmd.exe".to_string());
    candidates
}

#[cfg(not(windows))]
fn shell_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.trim().is_empty() {
            candidates.push(shell);
        }
    }
    candidates.extend(["/bin/zsh", "/bin/bash", "/bin/sh"].map(str::to_string));
    candidates
}

/// 候选 → 第一个可执行项（纯逻辑：存在性判定注入，单测覆盖顺序/空串/
/// 坏 PATH 条目跳过）。
fn pick_shell(candidates: &[String], mut exists: impl FnMut(&str) -> bool) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| !candidate.trim().is_empty() && exists(candidate))
        .cloned()
}

/// 可执行判定：含路径分隔符 = 直接查文件；裸名 = 按 PATH 逐目录查同名
/// 文件（候选全是带 .exe 的显式名，不需要 PATHEXT 推断）。
fn is_executable(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Path::new(trimmed).is_file();
    }
    let Some(path_env) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_env).any(|dir| {
        let candidate = dir.join(trimmed);
        candidate.is_file()
    })
}

/// 启动用的 shell；一个都不可用 = Err（不猜、不静默降级到某个不存在的
/// 路径——spawn 那一步的报错会失去"为什么"）。
fn resolve_shell() -> Result<String, String> {
    let candidates = shell_candidates();
    pick_shell(&candidates, is_executable).ok_or_else(|| {
        format!(
            "没有可用的 shell（已试: {}）",
            candidates.join(" / ")
        )
    })
}

/// 终端 cwd：显式传入（当前会话工作区）必须是目录；未传才取系统 home。
fn resolve_cwd(requested: Option<String>) -> Result<PathBuf, String> {
    if let Some(raw) = requested {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("工作区目录参数为空字符串".to_string());
        }
        let path = PathBuf::from(trimmed);
        if !path.is_dir() {
            return Err(format!("工作区目录不可用（不是目录）: {}", path.display()));
        }
        return Ok(path);
    }
    default_cwd()
}

/// 终端 cwd 缺省 = 系统 home。取不到/非目录 = Err。
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

/// 退出信息（事件载荷与 attach 回放共用一份形状）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub exit_code: Option<u32>,
    pub error: Option<String>,
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

/// attach 结果：data = 未送达输出的 base64（空串 = 没有），exit = 会话
/// 已退出时的退出信息（事件抢先发过或前端还没订阅，都会在这里补一次）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    data: String,
    exit: Option<ExitInfo>,
}

/// spawn 结果：shell 原串给前端做页签名（ZCode formatShellLabel 同源），
/// cwd 给前端做页签标题（ZCode formatTerminalTabTitle 的 projectName）。
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
    cwd: Option<String>,
    owner_label: String,
    owner_token: String,
) -> Result<Spawned, String> {
    // 先解析 shell/cwd（便宜且可能失败），再占 id——失败不消耗会话号
    let cwd = resolve_cwd(cwd)?;
    let shell = resolve_shell()?;
    let owner = SessionOwner {
        label: owner_label,
        token: owner_token,
    };

    // 同一窗口上一代页面遗留的会话先回收（页面 reload 后旧页面发不出 kill；
    // spawn 是权威入口，顺带把孤儿清掉——boot 的 terminal_reap 之外的兜底）
    reap_stale_sessions(&state, &owner)?;

    // id 分配（owner 随会话句柄一起落登记——PTY 创建失败不留半条记录）
    let id = {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner.alloc_id()
    };

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
    // 交互终端环境（ZCode resolveTerminalEnv 同源）：Windows 下 ConPTY 也
    // 照样传——git/npm/彩色输出的能力探测读的就是这两个变量。
    cmd.env("TERM", "xterm-256color");
    if std::env::var_os("COLORTERM").is_none() {
        cmd.env("COLORTERM", "truecolor");
    }

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

    let handle = Arc::new(SessionHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        output: Mutex::new(OutputState::default()),
    });
    state.insert(id, owner, handle.clone())?;

    // 输出泵：读 PTY → terminal-output:{id}。未 attach 时先进 backlog
    // （见模块头【首屏输出不能丢】）。EOF（子进程退出/PTY 关闭）或事件
    // 通道失效（应用退出中）即收线；wait 线程负责退出上报。
    let app_pump = app.clone();
    let pump_handle = handle.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    let emit_now = match pump_handle.output.lock() {
                        Ok(mut out) => out.offer(chunk.clone()),
                        Err(_) => {
                            // 缓冲锁中毒：输出无处安放（既不能缓存也不能
                            // 保证顺序），收线并留日志（线程无处返 Err）
                            eprintln!("[terminal:{id}] output mutex poisoned, pump stops");
                            break;
                        }
                    };
                    if !emit_now {
                        continue;
                    }
                    let event = TerminalOutputEvent {
                        id,
                        data: base64::engine::general_purpose::STANDARD.encode(&chunk),
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

    // wait 线程：阻塞到子进程退出 → 记录退出态（attach 晚到也能补发）→
    // 摘除登记（释放 PTY）→ 上报退出码。
    let registry = state.inner().clone();
    let app_wait = app;
    let wait_handle = handle;
    std::thread::spawn(move || {
        let status = child.wait();
        let (exit_code, error) = match status {
            Ok(s) => (Some(s.exit_code()), None),
            Err(e) => (None, Some(format!("PTY wait 失败: {e}"))),
        };
        let info = ExitInfo { exit_code, error };

        let emit_now = match wait_handle.output.lock() {
            Ok(mut out) => {
                out.exited = Some(info.clone());
                out.attached
            }
            Err(_) => false,
        };
        // 先摘登记再上报：摘除后 attach 会明确 Err（前端按"会话已结束"处理），
        // 不会把已死会话当成活会话接上
        if let Err(e) = registry.remove(id) {
            eprintln!("[terminal:{id}] registry remove failed: {e}");
        }
        if emit_now {
            let event = TerminalExitEvent {
                id,
                exit_code: info.exit_code,
                error: info.error.clone(),
            };
            // emit 失败 = 无接收方（应用退出中）——无处可报，留日志
            if let Err(e) = app_wait.emit(&format!("terminal-exit:{id}"), event) {
                eprintln!("[terminal:{id}] exit emit failed: {e}");
            }
        }
        eprintln!(
            "[terminal:{id}] exited (code {:?}, error {:?})",
            info.exit_code, info.error
        );
    });

    Ok(Spawned {
        id,
        shell,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

/// attach 会话输出：返回 backlog（一次性回放）+ 退出补发。前端必须在
/// 订阅 terminal-output/terminal-exit 之后调用——此后事件与 backlog 的
/// 先后由前端 TerminalOutputGate 保证（见 terminal-pane.tsx）。
#[tauri::command(async)]
pub fn terminal_attach(state: State<Arc<TerminalRegistry>>, id: u32) -> Result<Attached, String> {
    let handle = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "terminal registry mutex poisoned".to_string())?;
        inner
            .sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                format!("终端会话 {id} 已结束（attach 时已不在注册表——shell 启动后立即退出）")
            })?
    };
    let mut out = handle
        .output
        .lock()
        .map_err(|_| format!("终端会话 {id} output mutex poisoned"))?;
    let backlog = out.attach();
    Ok(Attached {
        data: base64::engine::general_purpose::STANDARD.encode(backlog),
        exit: out.exited.clone(),
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
///
/// killer 的返回值**不作为成败**（portable-pty 0.8.1 Windows 判定反了，
/// 见 `kill_session` 注释）：调用后照常返回 Ok，终止与否以 exit 事件 +
/// 登记摘除为准。
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
    kill_session(id, &handle);
    Ok(())
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

    /// id 注册表纯逻辑：单调递增、**不复用**（旧页面迟到的 kill/attach
    /// 不会误伤新会话），且**没有会话数上限**（ZCode 对齐，2026-11-18）。
    #[test]
    fn alloc_id_is_monotonic_and_uncapped() {
        let mut inner = RegistryInner::default();
        let mut ids = Vec::new();
        for _ in 0..32 {
            let id = inner.alloc_id();
            inner.sessions.insert(id, Arc::new(SessionHandle {
                writer: Mutex::new(Box::new(std::io::sink())),
                master: Mutex::new(unreachable_master()),
                killer: Mutex::new(Box::new(NoKill)),
                output: Mutex::new(OutputState::default()),
            }));
            ids.push(id);
        }
        assert_eq!(ids, (1..=32).collect::<Vec<_>>());
        // 摘除后 id 不复用（下一个是 33，不是 1）
        inner.sessions.remove(&ids[0]);
        assert_eq!(inner.alloc_id(), 33);
    }

    /// 孤儿判定：同 webview label、token 不是当前页面的会话 = 上一代页面
    /// 遗留（reap 目标）；当前 token 与其他 label 的会话都不动。
    #[test]
    fn stale_sessions_are_scoped_by_label_and_token() {
        let mut inner = RegistryInner::default();
        inner.owners.insert(
            1,
            SessionOwner { label: "main".into(), token: "old".into() },
        );
        inner.owners.insert(
            2,
            SessionOwner { label: "main".into(), token: "new".into() },
        );
        inner.owners.insert(
            3,
            SessionOwner { label: "quick".into(), token: "old".into() },
        );
        let current = SessionOwner { label: "main".into(), token: "new".into() };
        assert_eq!(inner.stale_sessions_for(&current), vec![1]);
        // 首次加载（无任何本 label 会话）= 没有孤儿
        let fresh = SessionOwner { label: "hud".into(), token: "t0".into() };
        assert_eq!(inner.stale_sessions_for(&fresh), Vec::<u32>::new());
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

    // ── 输出缓冲 / attach 交接（首屏输出不丢的机制） ──────────────────────

    /// 未 attach：全部入 backlog，保持顺序；attach 一次性取走并置位。
    #[test]
    fn output_backlog_keeps_order_and_attach_drains_it() {
        let mut out = OutputState::default();
        assert!(!out.offer(b"first".to_vec()));
        assert!(!out.offer(b"second".to_vec()));
        assert_eq!(out.attach(), b"firstsecond".to_vec());
        assert!(out.attached);
        // attach 之后再进输出 = 直接走事件（不进 backlog）
        assert!(out.offer(b"live".to_vec()));
        assert_eq!(out.attach(), Vec::<u8>::new());
    }

    /// 上限：超出 BACKLOG_MAX_BYTES 丢最旧整块，保留尾部（内存上界策略）。
    #[test]
    fn output_backlog_drops_oldest_beyond_cap() {
        let mut out = OutputState::default();
        let chunk = vec![b'x'; 64 * 1024];
        let chunks = BACKLOG_MAX_BYTES / chunk.len() + 4;
        for _ in 0..chunks {
            out.offer(chunk.clone());
        }
        assert!(out.backlog_bytes <= BACKLOG_MAX_BYTES);
        assert!(!out.backlog.is_empty());
        // 只保留了最近的若干块
        assert!(out.backlog.len() < chunks);
    }

    /// 单块超过上限时也要保留（不能把 8KB 的实时输出整块丢掉）。
    #[test]
    fn output_backlog_keeps_single_oversized_chunk() {
        let mut out = OutputState::default();
        let oversized = vec![b'y'; BACKLOG_MAX_BYTES + 16];
        out.offer(oversized.clone());
        assert_eq!(out.backlog.len(), 1);
        assert_eq!(out.attach().len(), oversized.len());
    }

    /// attach 晚于退出：exit 信息必须还在（前端靠它补发退出态）。
    #[test]
    fn output_attach_replays_exit_info() {
        let mut out = OutputState::default();
        out.exited = Some(ExitInfo {
            exit_code: Some(1),
            error: None,
        });
        let _ = out.attach();
        assert_eq!(out.exited.as_ref().and_then(|e| e.exit_code), Some(1));
    }

    // ── shell / cwd 裁定 ──────────────────────────────────────────────────

    /// 候选顺序：第一个存在者胜出；空串与不存在项跳过。
    #[test]
    fn pick_shell_takes_first_existing_candidate() {
        let candidates = vec![
            String::new(),
            "pwsh.exe".to_string(),
            "powershell.exe".to_string(),
            "cmd.exe".to_string(),
        ];
        // pwsh 不在：落到 powershell
        assert_eq!(
            pick_shell(&candidates, |c| c != "pwsh.exe"),
            Some("powershell.exe".to_string())
        );
        // pwsh 在：pwsh 优先（PSReadLine 重绘问题在 5.1 更严重）
        assert_eq!(
            pick_shell(&candidates, |c| c.ends_with(".exe")),
            Some("pwsh.exe".to_string())
        );
        // 一个都没有 = None（调用方 Err）
        assert_eq!(pick_shell(&candidates, |_| false), None);
    }

    /// 平台候选序列的形状（ComSpec 仅在其非空时出现，cmd.exe 兜底在末尾）。
    #[test]
    fn shell_candidates_have_expected_shape() {
        let candidates = shell_candidates();
        assert!(candidates.iter().all(|c| !c.trim().is_empty()));
        assert!(!candidates.is_empty());
        #[cfg(windows)]
        {
            assert_eq!(candidates[0], "pwsh.exe");
            assert_eq!(candidates[1], "powershell.exe");
            assert_eq!(candidates.last().unwrap(), "cmd.exe");
        }
        #[cfg(not(windows))]
        {
            assert_eq!(candidates.last().unwrap(), "/bin/sh");
        }
    }

    /// cwd：显式目录（存在）= 用它；不存在 = Err（不静默回退 home）；
    /// 未传 = 系统 home。
    #[test]
    fn resolve_cwd_validates_explicit_directory() {
        let temp = std::env::temp_dir();
        let resolved = resolve_cwd(Some(temp.to_string_lossy().into_owned()))
            .expect("temp dir is usable");
        assert_eq!(resolved, temp);

        let missing = temp.join("mirach-terminal-missing-dir-xyz");
        let err = resolve_cwd(Some(missing.to_string_lossy().into_owned()))
            .expect_err("missing dir must be Err");
        assert!(err.contains("工作区目录不可用"), "unexpected error: {err}");

        assert!(resolve_cwd(Some("   ".to_string())).is_err());

        let fallback = resolve_cwd(None).expect("home dir is usable in test env");
        assert!(fallback.is_dir());
    }
}
