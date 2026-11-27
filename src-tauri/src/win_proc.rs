//! Windows 子进程控制台窗口抑制（2026-11-27 用户实报：软件打开时闪几个黑框）。
//!
//! GUI 进程（windows 子系统）用 `std::process::Command` 起 `git` / `gh` / `tar`
//! 这类控制台程序时，Windows 默认会为子进程分配一个新的控制台窗口；即使
//! 只取 stdout/stderr，也会闪一下。宿主所有这类 spawn 都走
//! `HideConsole::hide_console()`（CREATE_NO_WINDOW），不再让用户看到黑框。
//!
//! 不改变命令行为，只改进程创建标志；非 Windows 平台是空操作。

use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait HideConsole {
    fn hide_console(&mut self) -> &mut Self;
}

impl HideConsole for Command {
    fn hide_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
