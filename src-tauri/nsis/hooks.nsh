; Mirach Harness NSIS hooks.
;
; Tauri's stock finish page only creates a desktop shortcut when the user
; leaves the "createDesktop" checkbox checked (and skips the page entirely in
; silent/passive mode). Users who click Finish without noticing the checkbox
; end up with no desktop icon (2026-11-27 用户："桌面怎么没有图标").
; Create/update it unconditionally after install; the macro is idempotent and
; also sets the AUMID like the stock shortcut helpers.

!macro NSIS_HOOK_POSTINSTALL
  Call CreateOrUpdateDesktopShortcut
!macroend
