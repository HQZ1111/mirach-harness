//! 数据同步（2026-11-23 重做）：设置页「数据与统计 → 数据同步」的数据面。
//!
//! 语义照 ZCode `docs/remote/data-sync.md`：**把本机配置推送到远端设备的
//! agent 目录**。远端设备 = ZCode 的三种远程工作区形态：
//! - **SSH**：`ssh` 直连远端主机；
//! - **WSL**：`wsl.exe -d <发行版>`；
//! - **Docker**：`docker exec <容器>`。
//!
//! 同步内容（宿主对偶）：
//! - `skills/`（技能）、`extensions/`（插件扩展）、`mcp.json`（MCP 服务器）；
//! - 子智能体 / 命令 / 钩子：宿主没有对应配置文件（分类为空）；
//! - 模型提供商：宿主没有独立的可推送配置文件（models.json 含密钥，不跨设备）。
//!
//! 传输 = 本机 `tar.exe` 打包 → 远端 `tar -xzf -` 解包到 `~/.rpi/agent`
//! （ZCode 推送到 `~/.zcode` 的宿主对偶）。只推送选中的分类；同名文件覆盖
//! （更新），远端独有文件保留——与 ZCode「仅新增或更新，保留远端独有内容」
//! 的规则一致。
//!
//! 设备记录存 `~/.rpi/agent/data-sync-devices.json`（与连接注册表无关：
//! ZCode 的数据同步设备是 SSH/WSL/Docker 工作区，不是网关连接）。
//!
//! 规矩 12：探测/测试/推送失败全部返回 Err 或 {ok:false,error}，不静默跳过。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::win_proc::HideConsole;

const DEVICES_FILE: &str = "data-sync-devices.json";
const DEVICE_VERSION: i64 = 1;
const REMOTE_AGENT_DIR: &str = "$HOME/.rpi/agent";
const SECRET_SERVICE: &str = "mirach.data-sync";

fn secret_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, id).map_err(|e| format!("凭据管理器不可用: {e}"))
}

fn store_secret(id: &str, secret: &str) -> Result<(), String> {
    secret_entry(id)?
        .set_password(secret)
        .map_err(|e| format!("写入 SSH 凭据失败: {e}"))
}

fn load_secret(id: &str) -> Result<Option<String>, String> {
    match secret_entry(id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 SSH 凭据失败: {e}")),
    }
}

fn clear_secret(id: &str) -> Result<(), String> {
    match secret_entry(id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除 SSH 凭据失败: {e}")),
    }
}

fn askpass_path() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join("mirach-ssh-askpass.cmd");
    let script = "@echo off\r\necho %MIRACH_SSH_SECRET%\r\n";
    std::fs::write(&path, script).map_err(|e| format!("askpass 脚本写入失败: {e}"))?;
    Ok(path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceRecord {
    pub id: String,
    /// ssh | wsl | docker
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// password | privateKey（ZCode 认证方式分段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// 写入口令（不落 JSON；进 OS 凭据管理器）
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    /// 私钥口令（写入口令，不落 JSON）
    #[serde(default, skip_serializing)]
    pub private_key_passphrase: Option<String>,
    /// 资源下载方式（local-download-upload | remote-download）——宿主只支持本地
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_install_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux_user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

fn devices_path() -> Result<PathBuf, String> {
    Ok(crate::pi_paths::agent_dir()?.join(DEVICES_FILE))
}

fn read_devices() -> Result<Vec<SyncDeviceRecord>, String> {
    let path = devices_path()?;
    let Some(doc) = crate::pi_settings::read_json_document(&path)? else {
        return Ok(Vec::new());
    };
    let Some(rows) = doc.get("devices").and_then(Value::as_array) else {
        return Err(format!("{} 的 devices 字段不是数组", path.display()));
    };
    rows.iter()
        .map(|row| {
            serde_json::from_value::<SyncDeviceRecord>(row.clone())
                .map_err(|e| format!("设备记录解析失败: {e}"))
        })
        .collect()
}

fn write_devices(devices: &[SyncDeviceRecord]) -> Result<(), String> {
    let path = devices_path()?;
    let doc = json!({ "version": DEVICE_VERSION, "devices": devices });
    crate::pi_settings::atomic_write_json(&path, &doc)
}

fn endpoint_of(device: &SyncDeviceRecord) -> String {
    match device.kind.as_str() {
        "ssh" => {
            let user = device.user.as_deref().unwrap_or("");
            let host = device.host.as_deref().unwrap_or("");
            let port = device
                .port
                .map(|p| format!(":{p}"))
                .unwrap_or_default();
            format!("{user}@{host}{port}")
        }
        "wsl" => {
            let distro = device
                .distro
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .unwrap_or("默认发行版");
            let user = device
                .linux_user
                .as_deref()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .map(|u| format!(" · {u}"))
                .unwrap_or_default();
            format!("{distro}{user}")
        }
        "docker" => device.container.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

fn validate_linux_user(user: &str) -> Result<(), String> {
    if user.chars().count() > 64 {
        return Err("Linux 用户名长度不能超过 64 个字符".into());
    }
    if user
        .chars()
        .any(|c| c.is_control() || c == ':' || c == '/' || c == '\\')
    {
        return Err("Linux 用户名不能包含控制字符、冒号、斜杠或反斜杠".into());
    }
    Ok(())
}

fn normalize_device(device: &mut SyncDeviceRecord) {
    let trim = |value: &mut Option<String>| {
        if let Some(text) = value {
            let trimmed = text.trim().to_string();
            *value = if trimmed.is_empty() { None } else { Some(trimmed) };
        }
    };
    trim(&mut device.host);
    trim(&mut device.user);
    trim(&mut device.key_path);
    trim(&mut device.auth);
    trim(&mut device.distro);
    trim(&mut device.linux_user);
    trim(&mut device.container);
    trim(&mut device.asset_install_mode);
    if let Some(password) = device.password.take() {
        let trimmed = password;
        device.password = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    if let Some(passphrase) = device.private_key_passphrase.take() {
        let trimmed = passphrase;
        device.private_key_passphrase = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    device.label = device.label.trim().to_string();
}

fn validate_device(device: &SyncDeviceRecord) -> Result<(), String> {
    match device.kind.as_str() {
        "ssh" => {
            if device.host.as_deref().unwrap_or("").trim().is_empty() {
                return Err("SSH 连接缺少主机".into());
            }
            if device.user.as_deref().unwrap_or("").trim().is_empty() {
                return Err("SSH 连接缺少用户名".into());
            }
            let auth = device.auth.as_deref().unwrap_or("password");
            if auth != "password" && auth != "privateKey" {
                return Err(format!("未知的 SSH 认证方式：{auth}"));
            }
            if auth == "password" && device.password.is_none() {
                return Err("请输入 SSH 密码".into());
            }
        }
        "wsl" => {
            if let Some(user) = device.linux_user.as_deref().filter(|u| !u.trim().is_empty()) {
                validate_linux_user(user.trim())?;
            }
        }
        "docker" => {
            if device.container.as_deref().unwrap_or("").trim().is_empty() {
                return Err("Docker 连接缺少容器名或 ID".into());
            }
        }
        other => return Err(format!("未知的设备类型：{other}")),
    }
    Ok(())
}

fn next_device_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("sync-{ms}")
}

/// 设备列表（数据同步专用设备存储，ZCode SSH/WSL/Docker 形态）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_devices() -> Result<Value, String> {
    let devices = read_devices()?;
    let rows: Vec<Value> = devices
        .iter()
        .map(|device| {
            let label = if device.label.trim().is_empty() {
                endpoint_of(device)
            } else {
                device.label.clone()
            };
            json!({
                "id": device.id,
                "kind": device.kind,
                "kindLabel": match device.kind.as_str() {
                    "ssh" => "SSH",
                    "wsl" => "WSL",
                    "docker" => "Docker",
                    _ => &device.kind,
                },
                "label": label,
                "endpoint": endpoint_of(device),
                "distro": device.distro,
                "linuxUser": device.linux_user,
                "container": device.container,
            })
        })
        .collect();
    Ok(json!({ "devices": rows }))
}

/// 新建 / 更新设备。id 为空 = 新建（自动生成）；同 endpoint 的重复设备拒绝。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_device_save(device: SyncDeviceRecord) -> Result<Value, String> {
    let mut device = device;
    normalize_device(&mut device);
    validate_device(&device)?;
    let mut devices = read_devices()?;
    let mut record = device;
    if record.id.trim().is_empty() {
        record.id = next_device_id();
    }
    if record.label.trim().is_empty() {
        record.label = endpoint_of(&record);
    }
    // SSH 口令 / 私钥口令：只进 OS 凭据管理器，不落 devices JSON。
    let secret = record
        .password
        .take()
        .or_else(|| record.private_key_passphrase.take());
    if let Some(secret) = secret {
        store_secret(&record.id, &secret)?;
    }
    let duplicate = devices.iter().any(|row| {
        row.id != record.id && row.kind == record.kind && endpoint_of(row) == endpoint_of(&record)
    });
    if duplicate {
        return Err(format!("同目标的连接已存在：{}", endpoint_of(&record)));
    }
    match devices.iter_mut().find(|row| row.id == record.id) {
        Some(slot) => *slot = record.clone(),
        None => devices.push(record.clone()),
    }
    write_devices(&devices)?;
    Ok(json!({ "device": record }))
}

/// 删除设备。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_device_remove(id: String) -> Result<Value, String> {
    let mut devices = read_devices()?;
    let before = devices.len();
    devices.retain(|row| row.id != id);
    if devices.len() == before {
        return Err(format!("设备 {id} 不存在"));
    }
    write_devices(&devices)?;
    clear_secret(&id)?;
    Ok(json!({ "removed": true }))
}

/// 解码 WSL 的 `-l -q` 输出（UTF-16LE，Windows 自带命令）。
pub(crate) fn decode_wsl_output(bytes: &[u8]) -> Vec<String> {
    let odd_zeros = bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    let pairs = bytes.len() / 2;
    let text = if pairs > 0 && odd_zeros * 2 >= pairs {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    };
    text.replace('\0', "")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// 解析 `docker ps --format "{{.Names}}\t{{.Image}}"` 输出。
pub(crate) fn parse_docker_ps(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let (name, image) = line.split_once('\t').unwrap_or((line, ""));
            if name.is_empty() {
                None
            } else {
                Some((name.to_string(), image.to_string()))
            }
        })
        .collect()
}

fn run_capture(mut command: Command) -> Result<(bool, String), String> {
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .hide_console()
        .output()
        .map_err(|e| format!("命令启动失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok((true, stdout))
    } else {
        Ok((false, if stderr.trim().is_empty() { stdout } else { stderr }))
    }
}

fn decode_text_lossy(bytes: &[u8]) -> String {
    let odd_zeros = bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    let pairs = bytes.len() / 2;
    if pairs > 0 && odd_zeros * 2 >= pairs {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

fn run_capture_decoded(mut command: Command) -> Result<(bool, String), String> {
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .hide_console()
        .output()
        .map_err(|e| format!("命令启动失败: {e}"))?;
    let stdout = decode_text_lossy(&output.stdout);
    let stderr = decode_text_lossy(&output.stderr);
    if output.status.success() {
        Ok((true, stdout))
    } else {
        Ok((false, if stderr.trim().is_empty() { stdout } else { stderr }))
    }
}

fn wsl_command(device: &SyncDeviceRecord, script: &str) -> Command {
    let mut command = Command::new("wsl.exe");
    if let Some(distro) = device.distro.as_deref().filter(|d| !d.trim().is_empty()) {
        command.arg("-d").arg(distro.trim());
    }
    if let Some(user) = device
        .linux_user
        .as_deref()
        .filter(|u| !u.trim().is_empty())
    {
        command.arg("-u").arg(user.trim());
    }
    command.arg("--").arg("sh").arg("-lc").arg(script);
    command
}

fn docker_command(device: &SyncDeviceRecord, script: &str, interactive: bool) -> Command {
    let mut command = Command::new("docker");
    command.arg("exec");
    if interactive {
        command.arg("-i");
    }
    command
        .arg(device.container.as_deref().unwrap_or(""))
        .arg("sh")
        .arg("-lc")
        .arg(script);
    command
}

fn ssh_command(device: &SyncDeviceRecord, script: &str, secret: Option<&str>) -> Command {
    let mut command = Command::new("ssh");
    command.arg("-o").arg("BatchMode=yes");
    command.arg("-o").arg("ConnectTimeout=10");
    command.arg("-o").arg("StrictHostKeyChecking=accept-new");
    if let Some(port) = device.port {
        command.arg("-p").arg(port.to_string());
    }
    if let Some(key) = device.key_path.as_deref().filter(|k| !k.trim().is_empty()) {
        command.arg("-i").arg(key.trim());
    }
    let target = format!(
        "{}@{}",
        device.user.as_deref().unwrap_or("").trim(),
        device.host.as_deref().unwrap_or("").trim()
    );
    command.arg(target).arg(script);
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        if let Ok(path) = askpass_path() {
            command
                .env("MIRACH_SSH_SECRET", secret)
                .env("SSH_ASKPASS", path)
                .env("SSH_ASKPASS_REQUIRE", "force");
        }
    }
    command
}

/// SSH config Host 候选（`~/.ssh/config` 的 Host/HostName/User/Port/IdentityFile）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_ssh_config_hosts() -> Result<Value, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录".to_string())?;
    let path = PathBuf::from(home).join(".ssh").join("config");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    let mut hosts: Vec<Value> = Vec::new();
    let mut current: Option<(String, Option<String>, Option<String>, Option<u16>, Option<String>)> =
        None;
    let mut flush = |entry: Option<(String, Option<String>, Option<String>, Option<u16>, Option<String>)>| {
        if let Some((alias, host, user, port, key)) = entry {
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                return;
            }
            hosts.push(json!({
                "alias": alias,
                "host": host,
                "user": user,
                "port": port,
                "keyPath": key,
            }));
        }
    };
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        let value = parts.next().unwrap_or("").trim().to_string();
        match key.as_str() {
            "host" => {
                flush(current.take());
                // 一行多个 Host 只取第一个具体名字（ZCode 同样按 alias 列表展示）。
                let alias = value.split_whitespace().next().unwrap_or("").to_string();
                current = Some((alias, None, None, None, None));
            }
            "hostname" => {
                if let Some(entry) = current.as_mut() {
                    entry.1 = Some(value);
                }
            }
            "user" => {
                if let Some(entry) = current.as_mut() {
                    entry.2 = Some(value);
                }
            }
            "port" => {
                if let Some(entry) = current.as_mut() {
                    entry.3 = value.parse::<u16>().ok();
                }
            }
            "identityfile" => {
                if let Some(entry) = current.as_mut() {
                    entry.4 = Some(value);
                }
            }
            _ => {}
        }
    }
    flush(current.take());
    Ok(json!({ "hosts": hosts, "source": path.display().to_string() }))
}

/// 探测 WSL 发行版（`wsl.exe -l -q`）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_probe_wsl() -> Result<Value, String> {
    crate::pi_session::on_big_stack(move || {
        let output = Command::new("wsl.exe")
            .arg("-l")
            .arg("-q")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .hide_console()
            .output()
            .map_err(|e| format!("WSL 探测失败（wsl.exe 启动失败）：{e}"))?;
        let distros = decode_wsl_output(&output.stdout);
        if !output.status.success() && distros.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Ok(json!({
                "available": false,
                "distros": [],
                "error": if stderr.trim().is_empty() { "wsl.exe 退出非零".to_string() } else { stderr.to_string() },
            }));
        }
        Ok(json!({ "available": true, "distros": distros }))
    })?
}

/// 探测运行中的 Docker 容器（`docker ps --format`）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_probe_docker() -> Result<Value, String> {
    crate::pi_session::on_big_stack(move || {
        let mut command = Command::new("docker");
        command
            .arg("ps")
            .arg("--format")
            .arg("{{.Names}}\t{{.Image}}");
        match run_capture(command) {
            Ok((true, stdout)) => {
                let containers: Vec<Value> = parse_docker_ps(&stdout)
                    .into_iter()
                    .map(|(name, image)| json!({ "name": name, "image": image }))
                    .collect();
                Ok(json!({ "available": true, "containers": containers }))
            }
            Ok((false, detail)) => Ok(json!({
                "available": false,
                "containers": [],
                "error": detail,
            })),
            Err(e) => Ok(json!({ "available": false, "containers": [], "error": e })),
        }
    })?
}

/// 测试设备连通性（真执行远端命令）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_device_test(id: String) -> Result<Value, String> {
    crate::pi_session::on_big_stack(move || {
        let device = read_devices()?
            .into_iter()
            .find(|row| row.id == id)
            .ok_or_else(|| format!("设备 {id} 不存在"))?;
        let secret = if device.kind == "ssh" {
            load_secret(&device.id)?
        } else {
            None
        };
        let command = match device.kind.as_str() {
            "wsl" => wsl_command(&device, "printf ok"),
            "docker" => docker_command(&device, "printf ok", false),
            "ssh" => ssh_command(&device, "printf ok", secret.as_deref()),
            other => return Err(format!("未知的设备类型：{other}")),
        };
        let result = if device.kind == "wsl" {
            run_capture_decoded(command)
        } else {
            run_capture(command)
        };
        match result {
            Ok((true, stdout)) => Ok(json!({
                "ok": stdout.contains("ok"),
                "detail": stdout.trim(),
            })),
            Ok((false, detail)) => Ok(json!({ "ok": false, "error": detail })),
            Err(e) => Ok(json!({ "ok": false, "error": e })),
        }
    })?
}

fn build_archive(agent_dir: &Path, categories: &[String]) -> Result<PathBuf, String> {
    let mut items: Vec<&str> = Vec::new();
    for category in categories {
        match category.as_str() {
            "skills" => {
                if agent_dir.join("skills").is_dir() {
                    items.push("skills");
                }
            }
            "extensions" => {
                if agent_dir.join("extensions").is_dir() {
                    items.push("extensions");
                }
            }
            "mcp" => {
                if agent_dir.join("mcp.json").is_file() {
                    items.push("mcp.json");
                }
            }
            other => return Err(format!("未知的同步分类：{other}")),
        }
    }
    if items.is_empty() {
        return Err("本机没有所选分类的可同步内容".into());
    }
    let archive = std::env::temp_dir().join(format!(
        "mirach-sync-{}-{}.tar.gz",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    ));
    let mut command = Command::new("tar.exe");
    command.arg("-czf").arg(&archive).arg("-C").arg(agent_dir);
    for item in &items {
        command.arg(item);
    }
    match run_capture(command) {
        Ok((true, _)) => Ok(archive),
        Ok((false, detail)) => Err(format!("打包失败：{detail}")),
        Err(e) => Err(format!("打包失败（tar.exe 不可用？）：{e}")),
    }
}

fn extract_script() -> String {
    format!(
        "mkdir -p \"{REMOTE_AGENT_DIR}\" && tar -xzf - -C \"{REMOTE_AGENT_DIR}\""
    )
}

/// 推送选中的分类到设备（skills / extensions / mcp）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_push(id: String, categories: Option<Vec<String>>) -> Result<Value, String> {
    crate::pi_session::on_big_stack(move || {
        let device = read_devices()?
            .into_iter()
            .find(|row| row.id == id)
            .ok_or_else(|| format!("设备 {id} 不存在"))?;
        let selected: Vec<String> = categories.unwrap_or_else(|| {
            vec!["skills".into(), "extensions".into(), "mcp".into()]
        });
        let agent_dir = crate::pi_paths::agent_dir()?;
        let archive = build_archive(&agent_dir, &selected)?;
        let bytes = std::fs::read(&archive)
            .map_err(|e| format!("读取同步包失败 {}: {e}", archive.display()))?;
        let _ = std::fs::remove_file(&archive);
        let script = extract_script();
        let secret = if device.kind == "ssh" {
            load_secret(&device.id)?
        } else {
            None
        };
        let mut command = match device.kind.as_str() {
            "wsl" => wsl_command(&device, &script),
            "docker" => docker_command(&device, &script, true),
            "ssh" => ssh_command(&device, &script, secret.as_deref()),
            other => return Err(format!("未知的设备类型：{other}")),
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .hide_console()
            .spawn()
            .map_err(|e| format!("同步进程启动失败: {e}"))?;
        let write_result = match child.stdin.take() {
            Some(mut stdin) => stdin.write_all(&bytes),
            None => Ok(()),
        };
        let output = child
            .wait_with_output()
            .map_err(|e| format!("等待同步进程失败: {e}"))?;
        let stdout = decode_text_lossy(&output.stdout);
        let stderr = decode_text_lossy(&output.stderr);
        if !output.status.success() {
            // 进程提前退出时 stdin 写入会失败（Windows os error 109）；优先报
            // 远端 stderr（WSL/Docker/ssh 的真实原因），否则才报写包失败。
            let detail = if !stderr.trim().is_empty() {
                stderr
            } else if let Err(e) = &write_result {
                format!("写入同步包失败: {e}")
            } else if !stdout.trim().is_empty() {
                stdout
            } else {
                "远端未返回错误输出".to_string()
            };
            return Err(format!(
                "远端解包失败（exit {:?}）：{detail}",
                output.status.code()
            ));
        }
        if let Err(e) = write_result {
            return Err(format!("写入同步包失败: {e}"));
        }
        Ok(json!({
            "connectionId": device.id,
            "transferred": selected,
            "bytes": bytes.len(),
        }))
    })?
}

/// 本机分类清单（同步对话框的「本机」列）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_sync_manifest() -> Result<Value, String> {
    let agent = crate::pi_paths::agent_dir()?;
    let mcp_names: Vec<String> = crate::pi_mcp::raw_global_servers()?.keys().cloned().collect();
    let skills = dir_names(&agent.join("skills"));
    let extensions = dir_names(&agent.join("extensions"));
    Ok(json!({
        "categories": [
            { "key": "skills", "label": "技能", "count": skills.len(), "items": skills, "supported": true },
            { "key": "extensions", "label": "插件", "count": extensions.len(), "items": extensions, "supported": true },
            { "key": "mcp", "label": "MCP 服务器", "count": mcp_names.len(), "items": mcp_names, "supported": true },
            { "key": "subagents", "label": "子智能体", "count": 0, "items": [], "supported": false },
            { "key": "commands", "label": "命令", "count": 0, "items": [], "supported": false },
            { "key": "hooks", "label": "钩子", "count": 0, "items": [], "supported": false },
            { "key": "providers", "label": "模型提供商", "count": 0, "items": [], "supported": false },
        ]
    }))
}

fn dir_names(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path)
        .map(|it| {
            it.filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_output_decodes_utf16le() {
        let text = "Ubuntu-22.04\r\nDebian\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_wsl_output(&bytes), vec!["Ubuntu-22.04", "Debian"]);
    }

    #[test]
    fn wsl_output_decodes_utf8_fallback() {
        let bytes = b"Ubuntu\nDebian\n".to_vec();
        assert_eq!(decode_wsl_output(&bytes), vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn docker_ps_parses_name_and_image() {
        let rows = parse_docker_ps("api\tnginx:latest\nworker\t python:3 \n\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "api");
        assert_eq!(rows[0].1, "nginx:latest");
        assert_eq!(rows[1].0, "worker");
    }

    #[test]
    fn linux_user_validation() {
        assert!(validate_linux_user("root").is_ok());
        assert!(validate_linux_user("a:b").is_err());
        assert!(validate_linux_user("a/b").is_err());
        assert!(validate_linux_user("a\\b").is_err());
    }

    #[test]
    fn device_validation_requires_fields() {
        let mut device = SyncDeviceRecord {
            id: String::new(),
            kind: "ssh".into(),
            label: String::new(),
            host: Some("host".into()),
            port: None,
            user: Some("root".into()),
            key_path: None,
            auth: Some("password".into()),
            password: Some("pw".into()),
            private_key_passphrase: None,
            asset_install_mode: None,
            distro: None,
            linux_user: None,
            container: None,
        };
        assert!(validate_device(&device).is_ok());
        device.user = None;
        assert!(validate_device(&device).is_err());
        let docker = SyncDeviceRecord {
            id: String::new(),
            kind: "docker".into(),
            label: String::new(),
            host: None,
            port: None,
            user: None,
            key_path: None,
            auth: None,
            password: None,
            private_key_passphrase: None,
            asset_install_mode: None,
            distro: None,
            linux_user: None,
            container: Some("box".into()),
        };
        assert!(validate_device(&docker).is_ok());
    }
}
