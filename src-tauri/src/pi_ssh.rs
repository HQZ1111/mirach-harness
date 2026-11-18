//! SSH 隧道（2026-11-19）：`ssh -N -L` 端口转发到远端网关，宿主 WS 客户端
//! 经 `http://127.0.0.1:<local_port>` 连接。
//!
//! hermes 的 SSH 模式 = 1197 行的完整远端 backend 管理（bootstrap/健康检查/
//! dial claims）；宿主只需要 **端口转发** 这一层：远端网关已在跑，隧道打通后
//! 现有 `pi_gateway_connect` WS 客户端原样工作。
//!
//! - 远端网关端口 = 注册表 `gatewayPort`（缺省 = hermes api_server 默认 8642）；
//! - 本地端口 = 系统分配（TcpListener bind 0 → 取号释放）；
//! - 进程 = `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> -p <ssh_port>
//!   [-i <key_path>] <user>@<host>`，`BatchMode=yes`（不弹交互）、
//!   `ExitOnForwardFailure=yes`（转发失败立即退出，不留僵尸）；
//! - 生命周期：HashMap<connection_id, Child>；断开 / 删连接 / 应用退出时 kill。
//!
//! 规矩 12：ssh 进程启动失败 / 端口不通 = Err（UI 红显真错误），不假装连通。

use std::collections::HashMap;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::pi_connections;
use crate::pi_session::on_big_stack;

const DEFAULT_GATEWAY_PORT: u16 = 8642;
/// 隧道端口就绪等待（10s × 200ms = 2s 上限——本机 TCP accept 快）。
const TUNNEL_READY_RETRIES: usize = 10;
const TUNNEL_READY_INTERVAL_MS: u64 = 200;

struct SshTunnel {
    child: Child,
    local_port: u16,
}

fn tunnels() -> &'static Mutex<HashMap<String, SshTunnel>> {
    static CELL: OnceLock<Mutex<HashMap<String, SshTunnel>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("本地端口分配失败: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("本地端口读取失败: {e}"))
}

fn port_open(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
        && std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn build_ssh_args(
    host: &str,
    user: Option<&str>,
    ssh_port: Option<u16>,
    key_path: Option<&str>,
    local_port: u16,
    remote_port: u16,
) -> Vec<String> {
    let target = match user {
        Some(user) if !user.trim().is_empty() => format!("{}@{}", user.trim(), host),
        _ => host.to_string(),
    };
    let mut args = vec![
        "-N".into(),
        "-L".into(),
        format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
    ];
    if let Some(port) = ssh_port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    if let Some(key) = key_path.filter(|k| !k.trim().is_empty()) {
        args.push("-i".into());
        args.push(key.trim().to_string());
    }
    args.push(target);
    args
}

/// 启动（幂等）并返回隧道 URL（给 `pi_gateway_connect` 直接用）。
pub fn ensure_tunnel(connection_id: &str) -> Result<String, String> {
    let id = connection_id.trim();
    {
        let mut guard = tunnels().lock().expect("ssh tunnels poisoned");
        if let Some(tunnel) = guard.get_mut(id) {
            // 已有隧道：确认进程还活着，死了先关再走正常路径重新起。
            if tunnel.child.try_wait().map_err(|e| e.to_string())?.is_some() {
                let _ = tunnel.child.kill();
                let _ = tunnel.child.wait();
                guard.remove(id);
            } else {
                return Ok(format!("http://127.0.0.1:{}", tunnel.local_port));
            }
        }
    }
    start_tunnel_inner(id)
}

fn start_tunnel_inner(connection_id: &str) -> Result<String, String> {
    let registry = pi_connections::read_registry_for_tunnel(connection_id)?;
    let host = registry
        .host
        .as_deref()
        .filter(|h| !h.trim().is_empty())
        .ok_or_else(|| "ssh tunnel: 连接缺少 host".to_string())?
        .trim()
        .to_string();
    let user = registry.user.as_deref();
    let ssh_port = registry.port;
    let key_path = registry.key_path.as_deref();
    let remote_port = registry.gateway_port.unwrap_or(DEFAULT_GATEWAY_PORT);

    let local_port = pick_free_port()?;
    let args = build_ssh_args(&host, user, ssh_port, key_path, local_port, remote_port);

    let mut child = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ssh 进程启动失败: {e}"))?;

    let mut ready = false;
    for _ in 0..TUNNEL_READY_RETRIES {
        std::thread::sleep(Duration::from_millis(TUNNEL_READY_INTERVAL_MS));
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                return Err(format!(
                    "ssh 隧道进程提前退出（exit code {:?}）——检查密钥 / 主机可达性",
                    exit_status.code()
                ));
            }
            Ok(None) => {
                if port_open(local_port) {
                    ready = true;
                    break;
                }
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("ssh 进程状态读取失败: {e}"));
            }
        }
    }
    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        return Err("ssh 隧道端口未就绪（超时）——远端网关可能没在跑".into());
    }

    tunnels().lock().expect("ssh tunnels poisoned").insert(
        connection_id.to_string(),
        SshTunnel {
            child,
            local_port,
        },
    );
    Ok(format!("http://127.0.0.1:{local_port}"))
}

/// 启动（幂等：已有隧道先关再起）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_ssh_tunnel_start(connection_id: String) -> Result<Value, String> {
    on_big_stack(move || {
        let id = connection_id.trim().to_string();
        if id.is_empty() {
            return Err("ssh tunnel: connection_id 为空".into());
        }
        stop_tunnel(&id);
        let url = start_tunnel_inner(&id)?;
        let local_port = tunnels()
            .lock()
            .expect("ssh tunnels poisoned")
            .get(&id)
            .map(|t| t.local_port)
            .unwrap_or(0);
        Ok(json!({
            "local_port": local_port,
            "url": url,
            "remote_port": registry_gateway_port(&id),
        }))
    })?
}

fn registry_gateway_port(connection_id: &str) -> u16 {
    pi_connections::read_registry_for_tunnel(connection_id)
        .ok()
        .and_then(|r| r.gateway_port)
        .unwrap_or(DEFAULT_GATEWAY_PORT)
}

fn stop_tunnel(connection_id: &str) {
    if let Some(mut tunnel) = tunnels()
        .lock()
        .expect("ssh tunnels poisoned")
        .remove(connection_id)
    {
        let _ = tunnel.child.kill();
        let _ = tunnel.child.wait();
    }
}

/// 关闭隧道（断开连接 / 删连接时调用）。
#[tauri::command(rename_all = "camelCase", async)]
pub fn pi_ssh_tunnel_stop(connection_id: String) -> Result<Value, String> {
    stop_tunnel(connection_id.trim());
    Ok(json!({"stopped": true}))
}

/// 应用退出时关掉所有隧道（setup 的 on_exit 挂钩调用）。
pub fn stop_all() {
    let mut guard = tunnels().lock().expect("ssh tunnels poisoned");
    for (_, mut tunnel) in guard.drain() {
        let _ = tunnel.child.kill();
        let _ = tunnel.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_args_include_forward_and_auth() {
        let args = build_ssh_args(
            "gw.example.com",
            Some("ops"),
            Some(2222),
            Some("~/.ssh/id_ed25519"),
            18000,
            8642,
        );
        let joined = args.join(" ");
        assert!(joined.contains("-N"));
        assert!(joined.contains("-L 127.0.0.1:18000:127.0.0.1:8642"));
        assert!(joined.contains("-p 2222"));
        assert!(joined.contains("-i ~/.ssh/id_ed25519"));
        assert!(joined.contains("ops@gw.example.com"));
        assert!(joined.contains("BatchMode=yes"));
        assert!(joined.contains("ExitOnForwardFailure=yes"));
    }

    #[test]
    fn ssh_args_without_optional_fields() {
        let args = build_ssh_args("host", None, None, None, 18000, 8642);
        assert!(args.last().unwrap() == "host");
        assert!(!args.iter().any(|a| a == "-p"));
        assert!(!args.iter().any(|a| a == "-i"));
    }

    #[test]
    fn port_open_on_unbound_port_is_false() {
        // 端口 1 几乎不可能有服务（TCP well-known）；不 open 即通过
        assert!(!port_open(1));
    }
}
