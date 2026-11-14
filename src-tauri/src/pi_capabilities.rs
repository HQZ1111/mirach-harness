//! 技能与工具集的**写面**（左栏「技能与工具」独立页面的数据面）。
//!
//! 用户 2026-10-26："左侧栏的技能与工具完全复制 hermes 的" + "选 2，做成一个
//! 插件集成 rust 的"。hermes 的 `web/src/pages/SkillsPage.tsx` 是完整页面
//! （技能 / 工具集 / 浏览中心 三个视图 + 搜索 + 分类过滤 + 开关 + 编辑器），
//! 其数据面是 REST（`/api/skills`、`/api/tools/toolsets`）。宿主把同一套
//! 视图搬过来，数据面换成 IPC。
//!
//! ## 与 pi 的关系（先查事实，再动手）
//!
//! - **技能**：pi 从 `<global_dir>/skills/*/SKILL.md`、项目 `.pi/skills`、
//!   packages、以及 settings.json 的 `skills` 显式路径装载
//!   （`resources.rs:load_skills`）。pi **没有**"技能开关"概念——它只有
//!   `disable_model_invocation`（frontmatter，隐藏单个技能不让模型看到）。
//!   所以"启用/禁用"由宿主实现：禁用集存 `~/.pi/agent/harness-skills.json`
//!   （不进 settings.json——那是 pi 的 schema，塞私有键会被它忽略但污染
//!   用户配置），装载后过滤 + 重算系统提示。
//! - **工具集**：pi 没有 toolset 概念，只有 `KNOWN_TOOL_NAMES`
//!   （`tools.rs:5607`）与 `--tools` 选择。宿主的 toolset = **按语义把 pi
//!   的内置工具分组**（file / search / edit / shell / web / code-intel /
//!   media / plan / memory），组的启停映射到 `SessionOptions.enabled_tools`。
//!   分组表是本文件里的常量，与 pi 的工具清单一一对应——`tools.rs` 加新
//!   工具时这里要同步（有测试守着：每个 pi 工具必须落在某个组里）。
//!
//! ## 为什么技能提示由宿主渲染
//!
//! pi 的 `SessionOptions.skills_prompt` 是**宿主提供的字符串**
//! （`sdk.rs:399`，ACP 路径同样由调用方渲染，见 `acp.rs:1825`）。pi 自己
//! 不会去扫 skills 目录拼系统提示。所以宿主必须：
//! 1. 用 `pi::resources::load_skills` 装载（loader 语义零漂移）；
//! 2. 按禁用集过滤；
//! 3. `pi::resources::format_skills_for_prompt` 渲染成 `<available_skills>`；
//! 4. 建会话时喂 `SessionOptions.skills_prompt`。
//!
//! 这也是"技能开关"能真正生效的唯一位置——pi 侧无此概念。
//!
//! ## 纪律
//!
//! 错误一律传播（规矩 12）：读配置失败、写文件失败、名字非法都不吞。
//! 技能名走 pi 自己的校验器（`resources::validate_name`），与 loader 同源。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use pi::config::Config;

use crate::pi_session::on_big_stack;

/// 宿主侧的技能禁用集 / 工具集启用集的落点。
///
/// **不放 settings.json**：那是 pi 的 schema（`Config` 是 `#[serde(default)]`
/// 的强类型结构，塞私有键会被忽略，但会污染用户的配置文件、也会在 pi 版本
/// 升级时被它的写回覆盖）。放同目录的独立文件，与 `harness-*` 前缀对齐。
fn harness_prefs_path() -> PathBuf {
    Config::global_dir().join("harness-capabilities.json")
}

/// 技能禁用集 + 工具集开关（`harness-capabilities.json` 的形状）。
///
/// 工具集的启用语义是**双向**的：pi 的默认集（`default_enabled_toolsets`）
/// 之外还有一批 opt-in 组（memory / media / browser / computer / github /
/// python / security / skills / subagent）——它们默认关闭，用户显式打开的
/// 记在 `enabled_toolsets`。所以：
///
/// ```text
/// 组启用 = (在默认集 且 不在 disabled_toolsets) 或 在 enabled_toolsets
/// ```
///
/// 只存 `disabled_toolsets` 一个列表的话，opt-in 组永远开不了——实测踩过
/// （2026-10-26：开「记忆」写盘后读回仍是 false）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CapabilityPrefs {
    /// 被用户关掉的技能名（不区分大小写比较，落盘保留原样）。
    pub disabled_skills: Vec<String>,
    /// 被用户关掉的工具集 key（只对默认开启的组有意义）。
    pub disabled_toolsets: Vec<String>,
    /// 被用户**显式开启**的工具集 key（opt-in 组的唯一启用途径）。
    pub enabled_toolsets: Vec<String>,
}

impl CapabilityPrefs {
    /// 工具集当前是否启用（见类型注释的语义式）。
    fn toolset_enabled(&self, key: &str) -> bool {
        if self.enabled_toolsets.iter().any(|k| k == key) {
            return true;
        }
        default_enabled_toolsets().contains(key)
            && !self.disabled_toolsets.iter().any(|k| k == key)
    }

    /// 当前会话应传给 pi 的 `enabled_tools`。
    ///
    /// `None` = 用户没动过任何开关（禁用集与显式启用集都空）——此时不传，
    /// 让 pi 用自己的默认集（pi 升级加了新默认工具时自动跟上）。
    fn session_enabled_tools(&self) -> Option<Vec<String>> {
        if self.disabled_toolsets.is_empty() && self.enabled_toolsets.is_empty() {
            return None;
        }
        let mut keys: BTreeSet<String> = default_enabled_toolsets();
        for key in &self.disabled_toolsets {
            keys.remove(key);
        }
        for key in &self.enabled_toolsets {
            keys.insert(key.clone());
        }
        Some(enabled_tools_for(&keys))
    }
}

fn read_prefs() -> Result<CapabilityPrefs, String> {
    let path = harness_prefs_path();
    match std::fs::read_to_string(&path) {
        Ok(raw) if raw.trim().is_empty() => Ok(CapabilityPrefs::default()),
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|e| format!("能力偏好解析失败 {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(CapabilityPrefs::default()),
        Err(e) => Err(format!("能力偏好读取失败 {}: {e}", path.display())),
    }
}

fn write_prefs(prefs: &CapabilityPrefs) -> Result<(), String> {
    let path = harness_prefs_path();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("能力偏好目录创建失败 {}: {e}", parent.display()))?;
    let mut contents = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("能力偏好序列化失败: {e}"))?;
    contents.push('\n');
    let tmp = parent.join(format!("harness-capabilities.json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, contents.as_bytes())
        .map_err(|e| format!("能力偏好写入失败 {}: {e}", path.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("能力偏好替换失败 {}: {e}", path.display()))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
}

// ── 工具集分组表 ────────────────────────────────────────────────────────
//
// 分组依据 = pi 的 `KNOWN_TOOL_NAMES`（`tools.rs:5607`）逐项归类。**每个
// pi 工具都必须落在某一组里**——`every_pi_tool_belongs_to_a_toolset` 守着
// 这条不变量，`tools.rs` 加新工具而这里漏掉会立刻失败。
//
// 默认启用 = 与 pi CLI 的 `default_value`（`cli.rs:538`）完全一致的集合：
// read,bash,edit,write,grep,find,ls,hashline_edit,web_search,ast_grep,
// ast_edit,lsp,debug,ask,todo,submit_plan,jobs,hub,current_time

/// 一个工具集（hermes `ToolsetInfo` 的宿主对应物）。
pub struct ToolsetDef {
    /// 稳定 key（落盘用，不随 label 变）。
    pub key: &'static str,
    /// 展示名（hermes 的 `label`）。
    pub label: &'static str,
    /// 一句话说明（hermes 的 `description`）。
    pub description: &'static str,
    /// 该组包含的 pi 工具名（`tools.rs` 的 `Tool::name()` 返回值）。
    pub tools: &'static [&'static str],
}

pub const TOOLSETS: &[ToolsetDef] = &[
    ToolsetDef {
        key: "file",
        label: "文件",
        description: "读写文件、列目录、按 glob 找文件",
        tools: &["read", "write", "ls", "find"],
    },
    ToolsetDef {
        key: "edit",
        label: "编辑",
        description: "精确替换与基于行哈希的编辑",
        tools: &["edit", "hashline_edit"],
    },
    ToolsetDef {
        key: "search",
        label: "搜索",
        description: "按内容搜索文件（尊重 .gitignore）",
        tools: &["grep"],
    },
    ToolsetDef {
        key: "shell",
        label: "终端",
        description: "执行命令、管理后台任务与长驻进程",
        tools: &["bash", "jobs", "hub"],
    },
    ToolsetDef {
        key: "web",
        label: "联网",
        description: "联网搜索（多 provider 链自动降级）",
        tools: &["web_search"],
    },
    ToolsetDef {
        key: "code-intel",
        label: "代码智能",
        description: "AST 结构化搜索与改写、LSP、调试器",
        tools: &["ast_grep", "ast_edit", "lsp", "debug"],
    },
    ToolsetDef {
        key: "plan",
        label: "计划与协作",
        description: "任务清单、计划提交、向用户提问",
        tools: &["todo", "submit_plan", "ask"],
    },
    ToolsetDef {
        key: "subagent",
        label: "子代理",
        description: "把子任务派给独立代理（pi 默认不启用，开启后模型可委派）",
        tools: &["subagent"],
    },
    ToolsetDef {
        key: "time",
        label: "时间",
        description: "真实墙钟时间（UTC / 本地 / ISO 周）",
        tools: &["current_time"],
    },
    ToolsetDef {
        key: "memory",
        label: "记忆",
        description: "项目事实与经验的持久化（需 pi 的 memory.backend 开启）",
        tools: &["retain", "recall", "reflect", "memory_edit", "learn"],
    },
    ToolsetDef {
        key: "media",
        label: "媒体",
        description: "图片理解、音视频附件、图像生成、语音合成（需 pi 的 media.* 开启）",
        tools: &["inspect_image", "read_media", "generate_image", "tts"],
    },
    ToolsetDef {
        key: "browser",
        label: "浏览器",
        description: "Chromium 自动化（导航、点击、截图、表单）",
        tools: &["browser"],
    },
    ToolsetDef {
        key: "computer",
        label: "电脑控制",
        description: "桌面截图与 OS 输入（需宿主审批）",
        tools: &["computer"],
    },
    ToolsetDef {
        key: "github",
        label: "GitHub",
        description: "通过 gh CLI 读 PR / issue / workflow",
        tools: &["github"],
    },
    ToolsetDef {
        key: "python",
        label: "Python",
        description: "持久 Python kernel（Jupyter 式单元格）",
        tools: &["eval"],
    },
    ToolsetDef {
        key: "security",
        label: "安全扫描",
        description: "依赖与代码安全扫描",
        tools: &["security_scan"],
    },
    ToolsetDef {
        key: "skills",
        label: "技能管理",
        description: "让 agent 自己编写与管理技能",
        tools: &["manage_skill"],
    },
];

/// pi CLI 的默认工具集（`cli.rs:538` 的 `default_value`，逐字）。
pub const DEFAULT_ENABLED_TOOLS: &[&str] = &[
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "hashline_edit",
    "web_search",
    "ast_grep",
    "ast_edit",
    "lsp",
    "debug",
    "ask",
    "todo",
    "submit_plan",
    "jobs",
    "hub",
    "current_time",
];

/// 由"启用的工具集"算出 `enabled_tools` 列表。
///
/// 语义：**取并集**，但只包含 `DEFAULT_ENABLED_TOOLS` 里的工具 + 显式开启
/// 的组。默认组（file/edit/search/shell/web/code-intel/plan/time）就是
/// pi 的默认集；其余组（memory/media/browser/computer/github/python/
/// security/skills）默认关闭，开启后其工具名才进列表。
///
/// 顺序按 `TOOLSETS` 声明序 + 组内声明序（pi 的 `enabled_tools` 是
/// `Vec<&str>`，顺序不影响语义，但稳定序便于日志比对）。
pub fn enabled_tools_for(enabled_keys: &BTreeSet<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for toolset in TOOLSETS {
        if !enabled_keys.contains(toolset.key) {
            continue;
        }
        for tool in toolset.tools {
            if !out.iter().any(|t| t == tool) {
                out.push((*tool).to_string());
            }
        }
    }
    out
}

/// 默认启用的工具集 key 集合（= pi 默认工具集覆盖的那些组）。
pub fn default_enabled_toolsets() -> BTreeSet<String> {
    TOOLSETS
        .iter()
        .filter(|ts| ts.tools.iter().any(|t| DEFAULT_ENABLED_TOOLS.contains(t)))
        .map(|ts| ts.key.to_string())
        .collect()
}

/// 会话创建用：当前应传给 `SessionOptions.enabled_tools` 的工具名。
///
/// 委托给 `CapabilityPrefs::session_enabled_tools`（双向语义：禁用集 +
/// 显式启用集）。`None` = 用户没动过任何开关——**不传比传一份算出来的
/// 列表更安全**：pi 升级加了新默认工具时，不传能自动拿到。
pub(crate) fn enabled_tools_for_session() -> Result<Option<Vec<String>>, String> {
    let prefs = read_prefs()?;
    Ok(prefs.session_enabled_tools())
}

// ── 技能面 ──────────────────────────────────────────────────────────────

/// 技能名校验（**逐条照抄 pi 的 `resources::validate_name`**）。
///
/// pi 的校验器是 `pub(crate)`（`resources.rs:1301`），宿主拿不到，所以这里
/// 复刻同一套规则。**规则必须与上游一致**：写进去的名字过不了 loader 的
/// 校验，技能就装不上（表现为"我建了但列表里没有"）。
///
/// 上游常量：`MAX_SKILL_NAME_LEN = 64`、`MAX_SKILL_DESC_LEN = 1024`
/// （`resources.rs:118-119`）。
const MAX_SKILL_NAME_LEN: usize = 64;
const MAX_SKILL_DESC_LEN: usize = 1024;

fn validate_skill_name(name: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if name.is_empty() {
        errors.push("技能名为空".to_string());
        return errors;
    }
    if name.len() > MAX_SKILL_NAME_LEN {
        errors.push(format!("技能名超过 {MAX_SKILL_NAME_LEN} 字符（{}）", name.len()));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        errors.push("技能名只能含小写字母 a-z、数字 0-9 和连字符".to_string());
    }
    if name.starts_with('-') || name.ends_with('-') {
        errors.push("技能名不能以连字符开头或结尾".to_string());
    }
    if name.contains("--") {
        errors.push("技能名不能含连续连字符".to_string());
    }
    errors
}

fn validate_skill_description(description: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if description.trim().is_empty() {
        errors.push("描述不能为空".to_string());
    } else if description.len() > MAX_SKILL_DESC_LEN {
        errors.push(format!(
            "描述超过 {MAX_SKILL_DESC_LEN} 字符（{}）",
            description.len()
        ));
    }
    errors
}

/// 技能目录（`<global_dir>/skills`；项目级 `.pi/skills` 由 loader 自己加）。
fn global_skills_dir() -> PathBuf {
    Config::global_dir().join("skills")
}

/// 一个技能行（hermes `SkillInfo` 的宿主对应物：name/description/enabled/
/// category/source/path）。
fn skill_rows(loaded: &pi::resources::LoadSkillsResult, disabled: &[String]) -> Vec<serde_json::Value> {
    loaded
        .skills
        .iter()
        .map(|s| {
            let is_disabled = disabled.iter().any(|d| d.eq_ignore_ascii_case(&s.name));
            serde_json::json!({
                "name": s.name,
                "description": s.description,
                "path": s.file_path.display().to_string(),
                "source": s.source,
                "enabled": !is_disabled,
                // hermes 的 category 来自技能目录层级；pi 的 source 是
                // "user"/"project"/"package:<name>"，没有 category 概念。
                // 这里用 source 当分类（诚实：不编造一个 pi 没有的维度）。
                "category": s.source,
                "disableModelInvocation": s.disable_model_invocation,
            })
        })
        .collect()
}

fn load_all_skills() -> Result<pi::resources::LoadSkillsResult, String> {
    let config = Config::load().map_err(|e| format!("pi 配置读取失败: {e}"))?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let skill_paths: Vec<PathBuf> = config
        .skills
        .clone()
        .unwrap_or_default()
        .iter()
        .map(PathBuf::from)
        .collect();
    Ok(pi::resources::load_skills(
        pi::resources::LoadSkillsOptions {
            cwd,
            agent_dir: Config::global_dir(),
            skill_paths,
            include_defaults: true,
        },
    ))
}

/// 技能 + 工具集的完整快照（页面首屏一次拉全，与 hermes 的
/// `Promise.all([getSkills, getToolsets])` 同形）。
#[tauri::command(async)]
pub fn pi_capabilities() -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let prefs = read_prefs()?;
        let loaded = load_all_skills()?;
        let skills = skill_rows(&loaded, &prefs.disabled_skills);

        let toolsets: Vec<serde_json::Value> = TOOLSETS
            .iter()
            .map(|ts| {
                serde_json::json!({
                    "key": ts.key,
                    "name": ts.key,
                    "label": ts.label,
                    "description": ts.description,
                    "enabled": prefs.toolset_enabled(ts.key),
                    // needsSetup = 该组的工具要 pi 配置项配合才真的能起来
                    // （memory 需 backend、media 需 enable_*、computer 需
                    // enable_computer）。UI 据此提示"开了也要先配 pi"。
                    "configured": !matches!(ts.key, "memory" | "media" | "computer"),
                    "tools": ts.tools,
                    "needsSetup": matches!(ts.key, "memory" | "media" | "computer"),
                })
            })
            .collect();

        let diagnostics: Vec<serde_json::Value> = loaded
            .diagnostics
            .iter()
            .map(|d| {
                serde_json::json!({
                    "kind": format!("{:?}", d.kind),
                    "message": d.message,
                    "path": d.path.display().to_string(),
                })
            })
            .collect();

        Ok(serde_json::json!({
            "agentDir": Config::global_dir().display().to_string(),
            "skillsDir": global_skills_dir().display().to_string(),
            "skills": skills,
            "toolsets": toolsets,
            "diagnostics": diagnostics,
        }))
    })?
}

/// 开关一个技能（写 `harness-capabilities.json` 的 disabledSkills）。
///
/// **不影响已存在的会话**（它们的系统提示在创建时就定了）——新会话生效。
/// 这是 pi 的语义（skills_prompt 是 SessionOptions 的入参），UI 要如实说明。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_set_skill_enabled(name: String, enabled: bool) -> Result<(), String> {
    on_big_stack(move || {
        if name.trim().is_empty() {
            return Err("技能名为空".to_string());
        }
        let mut prefs = read_prefs()?;
        prefs.disabled_skills.retain(|d| !d.eq_ignore_ascii_case(&name));
        if !enabled {
            prefs.disabled_skills.push(name);
        }
        write_prefs(&prefs)
    })?
}

/// 开关一个工具集。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_set_toolset_enabled(key: String, enabled: bool) -> Result<(), String> {
    on_big_stack(move || {
        if !TOOLSETS.iter().any(|ts| ts.key == key) {
            return Err(format!("未知工具集：{key}"));
        }
        let mut prefs = read_prefs()?;
        // 双向语义（见 CapabilityPrefs 的类型注释）：
        // - 启用 → 从禁用集移除 + 进显式启用集（opt-in 组的唯一开启途径）；
        // - 停用 → 进禁用集 + 从显式启用集移除（对 opt-in 组同样生效）。
        prefs.disabled_toolsets.retain(|k| k != &key);
        prefs.enabled_toolsets.retain(|k| k != &key);
        if enabled {
            prefs.enabled_toolsets.push(key);
        } else {
            prefs.disabled_toolsets.push(key);
        }
        write_prefs(&prefs)
    })?
}

/// 读一个技能文件（编辑器用）。`name` 必须是已装载技能的名字。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_read_skill(name: String) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let loaded = load_all_skills()?;
        let skill = loaded
            .skills
            .iter()
            .find(|s| s.name == name)
            .ok_or_else(|| format!("找不到技能：{name}"))?;
        let contents = std::fs::read_to_string(&skill.file_path)
            .map_err(|e| format!("技能文件读取失败 {}: {e}", skill.file_path.display()))?;
        Ok(serde_json::json!({
            "name": skill.name,
            "description": skill.description,
            "path": skill.file_path.display().to_string(),
            "source": skill.source,
            "contents": contents,
        }))
    })?
}

/// 写一个技能文件（新建或覆盖）。`name` 走 pi 的 `validate_name`。
///
/// 落点 = `<global_dir>/skills/<name>/SKILL.md`（全局技能目录；项目级
/// `.pi/skills` 由用户在项目里自己建——宿主不猜用户想写哪一层）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_write_skill(
    name: String,
    description: String,
    body: String,
) -> Result<serde_json::Value, String> {
    on_big_stack(move || {
        let name_errors = validate_skill_name(&name);
        if !name_errors.is_empty() {
            return Err(name_errors.join("; "));
        }
        let desc_errors = validate_skill_description(&description);
        if !desc_errors.is_empty() {
            return Err(desc_errors.join("; "));
        }
        let dir = global_skills_dir().join(&name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("技能目录创建失败 {}: {e}", dir.display()))?;
        let path = dir.join("SKILL.md");
        let contents = format!(
            "---\nname: {name}\ndescription: {description}\n---\n\n{}\n",
            body.trim_end()
        );
        std::fs::write(&path, contents.as_bytes())
            .map_err(|e| format!("技能文件写入失败 {}: {e}", path.display()))?;
        Ok(serde_json::json!({
            "name": name,
            "path": path.display().to_string(),
        }))
    })?
}

/// 删除一个技能（整目录）。只允许删全局技能目录下的——项目级/packages
/// 里的技能属于别人的工作区，宿主不碰。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_delete_skill(name: String) -> Result<(), String> {
    on_big_stack(move || {
        let name_errors = validate_skill_name(&name);
        if !name_errors.is_empty() {
            return Err(name_errors.join("; "));
        }
        let dir = global_skills_dir().join(&name);
        if !dir.exists() {
            return Err(format!(
                "技能不在全局目录下，拒绝删除（只删 {} 里的）：{name}",
                global_skills_dir().display()
            ));
        }
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("技能删除失败 {}: {e}", dir.display()))
    })?
}

/// 校验技能名与描述（**不落盘**）——新建/编辑表单在提交前就能看到规则错误，
/// 不必等写盘失败才知道。规则与 `pi_write_skill` 完全同源（同一对校验器）。
#[tauri::command(rename_all = "camelCase")]
pub fn pi_validate_skill(name: String, description: String) -> serde_json::Value {
    let mut errors = validate_skill_name(&name);
    errors.extend(validate_skill_description(&description));
    serde_json::json!({ "ok": errors.is_empty(), "errors": errors })
}

/// 会话创建用：按当前开关渲染的技能提示块（`<available_skills>`）。
///
/// 返回 `Ok(None)` = 没有可见技能（不注入空块）；读配置/装载失败一律 Err
/// （用户以为技能生效了、实际没生效，比报错难查得多）。
pub(crate) fn skills_prompt_for_session() -> Result<Option<String>, String> {
    let prefs = read_prefs()?;
    let loaded = load_all_skills()?;
    let visible: Vec<pi::resources::Skill> = loaded
        .skills
        .into_iter()
        .filter(|s| !prefs.disabled_skills.iter().any(|d| d.eq_ignore_ascii_case(&s.name)))
        .collect();
    if visible.is_empty() {
        return Ok(None);
    }
    let block = pi::resources::format_skills_for_prompt(&visible);
    Ok(if block.trim().is_empty() { None } else { Some(block) })
}

/// 定时任务用：只渲染**指定技能名**的提示块（作业级 `skills` 字段）。
///
/// 与 [`skills_prompt_for_session`] 的区别是**不做全局开关过滤**：
/// 作业里显式点名的技能是用户对这个作业的明确意图，全局禁用集不该
/// 静默把它拿掉（否则作业跑起来缺了关键指令，用户完全看不出来）。
///
/// 点名了但装载不到 → **Err**（规矩 12）。hermes 的 cron 也拒绝这种
/// 作业（`scheduler_preflight` 的 "attached skills are ready" 检查）。
pub(crate) fn load_skills_for_prompt(names: &[String]) -> Result<String, String> {
    if names.is_empty() {
        return Ok(String::new());
    }
    let loaded = load_all_skills()?;
    let mut picked: Vec<pi::resources::Skill> = Vec::new();
    let mut missing: Vec<&str> = Vec::new();
    for name in names {
        match loaded
            .skills
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(name.trim()))
        {
            Some(s) => picked.push(s.clone()),
            None => missing.push(name),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "作业点名的技能不存在：{}（可用 `pi_capabilities` 查已安装技能）",
            missing.join("、")
        ));
    }
    Ok(pi::resources::format_skills_for_prompt(&picked))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不变量：pi 的每个已知工具都必须落在某个工具集里。
    ///
    /// `tools.rs:KNOWN_TOOL_NAMES` 加新工具而这里漏掉 → 那个工具在 UI 里
    /// 既不能开也不能关（永远按 pi 默认走），用户会以为"开关坏了"。
    #[test]
    fn every_pi_tool_belongs_to_a_toolset() {
        let covered: BTreeSet<&str> = TOOLSETS
            .iter()
            .flat_map(|ts| ts.tools.iter().copied())
            .collect();
        for name in pi::tools::ToolRegistry::KNOWN_TOOL_NAMES {
            assert!(
                covered.contains(name),
                "pi 工具 `{name}` 没有归属任何工具集——请在 TOOLSETS 里登记"
            );
        }
    }

    /// 默认工具集必须精确覆盖 pi CLI 的默认 `--tools`（`cli.rs:538`）。
    ///
    /// 多一个 = 用户没开就拿到了额外能力；少一个 = pi 的默认能力被静默砍掉。
    #[test]
    fn default_toolsets_match_pi_cli_default() {
        let enabled = enabled_tools_for(&default_enabled_toolsets());
        let pi_default: BTreeSet<&str> = DEFAULT_ENABLED_TOOLS.iter().copied().collect();
        let ours: BTreeSet<&str> = enabled.iter().map(String::as_str).collect();
        assert_eq!(
            ours, pi_default,
            "默认工具集与 pi CLI 默认不一致（多：{:?}，少：{:?}）",
            ours.difference(&pi_default).collect::<Vec<_>>(),
            pi_default.difference(&ours).collect::<Vec<_>>()
        );
    }

    #[test]
    fn toolset_keys_are_unique() {
        let mut seen = BTreeSet::new();
        for ts in TOOLSETS {
            assert!(seen.insert(ts.key), "工具集 key 重复：{}", ts.key);
        }
    }

    #[test]
    fn enabled_tools_dedupes_across_toolsets() {
        let mut keys = default_enabled_toolsets();
        keys.insert("shell".to_string());
        let tools = enabled_tools_for(&keys);
        let unique: BTreeSet<&String> = tools.iter().collect();
        assert_eq!(tools.len(), unique.len(), "enabled_tools 有重复项");
    }

    #[test]
    fn disabling_a_toolset_removes_its_tools() {
        let mut keys = default_enabled_toolsets();
        keys.remove("web");
        let tools = enabled_tools_for(&keys);
        assert!(!tools.iter().any(|t| t == "web_search"));
    }

    /// 双向开关语义（2026-10-26 实测踩过的坑）：opt-in 组（默认不在 pi 默认
    /// 集里，如 memory）只靠"从禁用集移除"是开不了的——必须进显式启用集。
    #[test]
    fn optin_toolset_enable_requires_enabled_list() {
        // 只从禁用集移除（旧实现的错误形态）→ memory 仍是关的
        let wrong = CapabilityPrefs {
            disabled_toolsets: vec![],
            ..CapabilityPrefs::default()
        };
        assert!(!wrong.toolset_enabled("memory"));

        // 进显式启用集 → 开了
        let right = CapabilityPrefs {
            enabled_toolsets: vec!["memory".to_string()],
            ..CapabilityPrefs::default()
        };
        assert!(right.toolset_enabled("memory"));
    }

    /// 用户没动过任何开关 → 会话不传 enabled_tools（让 pi 用自己的默认集，
    /// 升级加了新默认工具时自动跟上）。
    #[test]
    fn untouched_prefs_yield_none() {
        assert!(CapabilityPrefs::default().session_enabled_tools().is_none());
    }

    /// 停用默认组 + 启用 opt-in 组 → 会话列表 = 默认 - 停用 + 启用。
    #[test]
    fn session_tools_reflect_both_directions() {
        let prefs = CapabilityPrefs {
            disabled_toolsets: vec!["web".to_string()],
            enabled_toolsets: vec!["memory".to_string()],
            ..CapabilityPrefs::default()
        };
        let tools = prefs.session_enabled_tools().expect("有开关就必须传列表");
        assert!(!tools.iter().any(|t| t == "web_search"), "停用的组不该出现");
        assert!(tools.iter().any(|t| t == "retain"), "显式启用的组要出现");
        assert!(tools.iter().any(|t| t == "read"), "其余默认工具保持");
    }

    /// 对 opt-in 组停用同样生效（从显式启用集移除 + 进禁用集）。
    #[test]
    fn disabling_optin_toolset_works() {
        let mut prefs = CapabilityPrefs {
            enabled_toolsets: vec!["memory".to_string()],
            ..CapabilityPrefs::default()
        };
        prefs.enabled_toolsets.retain(|k| k != "memory");
        prefs.disabled_toolsets.push("memory".to_string());
        assert!(!prefs.toolset_enabled("memory"));
    }
}
