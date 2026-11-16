//! 房间附件（hermes `gateway/hosted_room_attachments.py` 的校验层移植）。
//!
//! 这是 hermes 群聊里**单文件最大**的模块（1,364 行），核心是文件上传/下载/配额/
//! 完整性。本文件先移植**纯校验层**（不碰 SQL 与磁盘）：
//!
//! - 标识符 / attachment_id / blob_id 的形状校验
//! - 文件名：必须是**有界 basename**（拒绝 `/ \ NUL LF CR`、`.`、`..`）
//! - MIME：小写、有界、符合 RFC 形状
//! - kind：只能是 `image` / `pdf` / `file`
//! - **字节嗅探**（magic number）：PNG/JPEG/GIF/BMP/WebP/PDF/ZIP/gzip/UTF-8 文本
//! - **嗅探结果与声明必须一致**（image/pdf 严格；text 严格；通用文件宽容）
//! - base64 严格解码（拒绝 data URL、拒绝空、拒绝超限）
//!
//! ## 安全语义（上游注释点明的取舍）
//!
//! > Generic files are opaque bytes. ZIP and gzip are container formats used by
//! > many non-archive MIME types (DOCX, XLSX, PPTX, EPUB, JAR, APK, etc.). Only
//! > **image and PDF payloads are security-sensitive enough to require an exact
//! > magic/MIME match** here; text remains strict to avoid binary prompts.
//!
//! 即：只有 image/pdf/text 做严格 magic 比对，通用文件不做——否则 DOCX 之流
//! 全会被拒。这个取舍必须保留。

use base64::Engine as _;
use serde_json::Value;

// ── 常量（上游逐字）────────────────────────────────────────────────────────

pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 8;
pub const MAX_ATTACHMENT_BYTES: usize = 15_000_000;
pub const MAX_MESSAGE_ATTACHMENT_BYTES: usize = 25_000_000;
pub const MAX_ROOM_ATTACHMENT_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_GATEWAY_BLOB_BYTES: usize = 2 * 1024 * 1024 * 1024;
pub const MAX_ROOM_ATTACHMENT_COUNT: usize = 50_000;
pub const MAX_GATEWAY_ATTACHMENT_COUNT: usize = 200_000;
pub const MAX_ROOM_UNCOMMITTED_BYTES: usize = 100 * 1024 * 1024;
pub const MAX_ROOM_UNCOMMITTED_COUNT: usize = 64;
pub const MAX_TASK_ATTACHMENTS: usize = 16;
pub const MAX_TASK_ATTACHMENT_BYTES: usize = 50_000_000;
pub const UNCOMMITTED_TTL_SECONDS: f64 = 60.0 * 60.0;
pub const DISBANDED_GRACE_SECONDS: f64 = 15.0 * 60.0;
pub const CLASSIC_ATTACHMENT_TTL_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;

pub const MAX_ATTACHMENT_NAME_CHARS: usize = 255;
pub const MAX_ATTACHMENT_MIME_CHARS: usize = 127;
pub const MAX_IDENTIFIER_CHARS: usize = 128;

/// 清单项的精确字段集。
pub const ATTACHMENT_FIELDS: &[&str] = &["attachment_id", "kind", "name", "size", "mime"];

/// 允许的附件类型。
pub const ATTACHMENT_KINDS: &[&str] = &["image", "pdf", "file"];

// ── 错误 ────────────────────────────────────────────────────────────────────

/// 上游 `AttachmentError` 家族（code 区分：not-found / conflict / quota / integrity）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentError {
    pub code: &'static str,
    pub message: String,
}

impl AttachmentError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: "attachment",
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AttachmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AttachmentError {}

fn fail<T>(message: impl Into<String>) -> Result<T, AttachmentError> {
    Err(AttachmentError::new(message))
}

pub type AttachResult<T> = Result<T, AttachmentError>;

// ── 形状校验 ────────────────────────────────────────────────────────────────

/// 上游 `_identifier()`。
pub fn identifier(value: &str, label: &str) -> AttachResult<String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.chars().count() > MAX_IDENTIFIER_CHARS
        || !super::common::is_identifier(normalized)
    {
        return fail(format!("invalid {label}"));
    }
    Ok(normalized.to_owned())
}

/// 上游 `_attachment_id()`：必须是 `att_` + 32 位小写 hex。
pub fn attachment_id(value: &str) -> AttachResult<String> {
    if !is_prefixed_hex32(value, "att_") {
        return fail("invalid attachment_id");
    }
    Ok(value.to_owned())
}

/// 上游 `_blob_id()`：必须是 `blob_` + 32 位小写 hex。
pub fn blob_id(value: &str) -> AttachResult<String> {
    if !is_prefixed_hex32(value, "blob_") {
        return fail("invalid blob_id");
    }
    Ok(value.to_owned())
}

fn is_prefixed_hex32(value: &str, prefix: &str) -> bool {
    let Some(rest) = value.strip_prefix(prefix) else {
        return false;
    };
    rest.len() == 32 && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 上游 `_name()`：必须是**有界 basename**。
///
/// 拒绝：空、超 255 字符、`.`、`..`、含 `/` `\` NUL LF CR。
/// （Rust 的 `&str` 天然是合法 UTF-8，所以上游的 Unicode 检查不需要。）
pub fn name(value: &str) -> AttachResult<String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.chars().count() > MAX_ATTACHMENT_NAME_CHARS
        || normalized == "."
        || normalized == ".."
        || normalized.contains('/')
        || normalized.contains('\\')
        || normalized.contains('\0')
        || normalized.contains('\n')
        || normalized.contains('\r')
    {
        return fail("attachment name must be a bounded basename");
    }
    Ok(normalized.to_owned())
}

/// 上游 `_mime()`：strip + 小写 + 形状校验。
///
/// 形状：`type/subtype`，两边各是 `[a-z0-9][a-z0-9!#$&^_.+-]*`（上游 `_MIME_RE`）。
pub fn mime(value: &str) -> AttachResult<String> {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty()
        || normalized.chars().count() > MAX_ATTACHMENT_MIME_CHARS
        || !is_mime_shape(&normalized)
    {
        return fail("attachment mime is invalid");
    }
    Ok(normalized)
}

/// 上游 `_MIME_RE` 的形状判定（手写以避免 regex 依赖）。
fn is_mime_shape(value: &str) -> bool {
    let mut parts = value.splitn(2, '/');
    let (Some(kind), Some(subtype)) = (parts.next(), parts.next()) else {
        return false;
    };
    if subtype.contains('/') {
        return false;
    }
    let token_ok = |token: &str| {
        let mut chars = token.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        if !first.is_ascii_alphanumeric() {
            return false;
        }
        chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'))
    };
    token_ok(kind) && token_ok(subtype)
}

/// 上游 `_kind()`。
pub fn kind(value: &str) -> AttachResult<String> {
    if !ATTACHMENT_KINDS.contains(&value) {
        return fail("attachment kind must be image, pdf, or file");
    }
    Ok(value.to_owned())
}

// ── 字节嗅探 ────────────────────────────────────────────────────────────────

/// 上游 `_sniff_known_mime()`：按 magic number 判已知类型。
///
/// 顺序与上游一致（PNG → JPEG → GIF → BMP → WebP → PDF → ZIP → gzip → text）。
pub fn sniff_known_mime(data: &[u8]) -> &'static str {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "image/png";
    }
    if data.starts_with(b"\xff\xd8\xff") {
        return "image/jpeg";
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if data.starts_with(b"BM") {
        return "image/bmp";
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return "image/webp";
    }
    if data.starts_with(b"%PDF-") {
        return "application/pdf";
    }
    if data.starts_with(b"PK\x03\x04") {
        return "application/zip";
    }
    if data.starts_with(b"\x1f\x8b") {
        return "application/gzip";
    }
    // 无 NUL 且能按 UTF-8 解码 → text/plain
    if !data.contains(&0) && std::str::from_utf8(data).is_ok() {
        return "text/plain";
    }
    "application/octet-stream"
}

/// 上游 `_validate_mime_and_kind()`：嗅探结果必须与声明一致。
///
/// 严格度分档（见模块头注释的取舍）：
/// - `image`：mime 必须以 `image/` 开头**且**嗅探结果完全等于 mime
/// - `pdf`：mime 必须是 `application/pdf`**且**嗅探也是 PDF
/// - 其余：mime 若是 image/pdf 类 → 报错（类型不匹配）
/// - `text/*`：嗅探必须是 `text/plain`
/// - 通用文件：不比对（DOCX/XLSX 等容器格式的 magic 是 ZIP，不能因此拒绝）
pub fn validate_mime_and_kind(data: &[u8], kind: &str, mime: &str) -> AttachResult<()> {
    let sniffed = sniff_known_mime(data);

    if kind == "image" {
        if !mime.starts_with("image/") || sniffed != mime {
            return fail("image bytes do not match the declared MIME type");
        }
        return Ok(());
    }
    if kind == "pdf" {
        if mime != "application/pdf" || sniffed != "application/pdf" {
            return fail("PDF bytes do not match application/pdf");
        }
        return Ok(());
    }

    // kind == "file"
    if mime.starts_with("image/") || mime == "application/pdf" {
        return fail("image and PDF MIME types require their matching kind");
    }
    if mime.starts_with("text/") && sniffed != "text/plain" {
        return fail("text bytes do not match the declared MIME type");
    }
    Ok(())
}

// ── base64 ──────────────────────────────────────────────────────────────────

/// 上游 `decode_content_base64()`：严格解码一个有界的 RPC 上传体。
///
/// 拒绝：非字符串、空、data URL 前缀、超编码上限、非法 base64、解码后超限、解码后空。
pub fn decode_content_base64(value: &str) -> AttachResult<Vec<u8>> {
    if value.is_empty() {
        return fail("content_base64 is required");
    }
    if value.trim_start().to_lowercase().starts_with("data:") {
        return fail("data URLs are not accepted");
    }
    // 上游：maximum_encoded = ((MAX_ATTACHMENT_BYTES + 2) // 3) * 4，再 +4 容差
    let maximum_encoded = ((MAX_ATTACHMENT_BYTES + 2) / 3) * 4;
    if value.len() > maximum_encoded + 4 {
        return fail("attachment exceeds the per-file size limit");
    }

    let engine = base64::engine::general_purpose::STANDARD;
    let data = engine
        .decode(value)
        .map_err(|_| AttachmentError::new("content_base64 is not valid base64"))?;

    if data.is_empty() {
        return fail("attachment must not be empty");
    }
    if data.len() > MAX_ATTACHMENT_BYTES {
        return fail("attachment exceeds the per-file size limit");
    }
    Ok(data)
}

/// 上游 `encode_content_base64()`。
pub fn encode_content_base64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

// ── 清单项 ──────────────────────────────────────────────────────────────────

/// 一条附件清单项（上游 `_ATTACHMENT_FIELDS` 的形状）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentManifestEntry {
    pub attachment_id: String,
    pub kind: String,
    pub name: String,
    pub size: i64,
    pub mime: String,
}

impl AttachmentManifestEntry {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "attachment_id": self.attachment_id,
            "kind": self.kind,
            "name": self.name,
            "size": self.size,
            "mime": self.mime,
        })
    }
}

/// 上游 `_safe_manifest_entry()`：严格校验一条清单项。
pub fn safe_manifest_entry(value: &Value) -> AttachResult<AttachmentManifestEntry> {
    let Value::Object(map) = value else {
        return fail("attachment entry must be an object");
    };
    if map.len() != ATTACHMENT_FIELDS.len() || !ATTACHMENT_FIELDS.iter().all(|f| map.contains_key(*f)) {
        return fail("attachment entry fields are invalid");
    }

    let attachment_id = attachment_id(map["attachment_id"].as_str().unwrap_or(""))?;
    let kind = kind(map["kind"].as_str().unwrap_or(""))?;
    let name = name(map["name"].as_str().unwrap_or(""))?;
    let mime = mime(map["mime"].as_str().unwrap_or(""))?;

    // size：非 bool 整数，0 <= size <= MAX_ATTACHMENT_BYTES
    let Some(size) = map.get("size").and_then(super::common::json_i64) else {
        return fail("attachment size is invalid");
    };
    if size < 0 || size as usize > MAX_ATTACHMENT_BYTES {
        return fail("attachment size is invalid");
    }

    Ok(AttachmentManifestEntry {
        attachment_id,
        kind,
        name,
        size,
        mime,
    })
}

/// 校验一整条消息的清单：条数上限 + 总字节上限 + 每项合法 + attachment_id 不重复。
pub fn validate_manifest(value: &Value) -> AttachResult<Vec<AttachmentManifestEntry>> {
    let Value::Array(items) = value else {
        return fail("attachments must be a list");
    };
    if items.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return fail("too many attachments");
    }

    let mut entries = Vec::with_capacity(items.len());
    let mut seen = std::collections::BTreeSet::new();
    let mut total: usize = 0;
    for item in items {
        let entry = safe_manifest_entry(item)?;
        if !seen.insert(entry.attachment_id.clone()) {
            return fail("attachment is duplicated");
        }
        total += entry.size as usize;
        entries.push(entry);
    }
    if total > MAX_MESSAGE_ATTACHMENT_BYTES {
        return fail("attachments exceed the per-message size limit");
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── 形状校验 ──────────────────────────────────────────────────────────

    #[test]
    fn identifier_strips_and_bounds() {
        assert_eq!(identifier("  abc  ", "room_id").unwrap(), "abc");
        assert!(identifier("   ", "room_id").is_err());
        assert!(identifier(&"a".repeat(129), "room_id").is_err());
    }

    #[test]
    fn attachment_id_requires_att_prefix_and_hex32() {
        let good = format!("att_{}", "a".repeat(32));
        assert!(attachment_id(&good).is_ok());
        // 大写 hex 不接受
        assert!(attachment_id(&format!("att_{}", "A".repeat(32))).is_err());
        // 长度不对
        assert!(attachment_id(&format!("att_{}", "a".repeat(31))).is_err());
        // 前缀不对
        assert!(attachment_id(&format!("blob_{}", "a".repeat(32))).is_err());
    }

    #[test]
    fn blob_id_requires_blob_prefix() {
        assert!(blob_id(&format!("blob_{}", "0".repeat(32))).is_ok());
        assert!(blob_id(&format!("att_{}", "0".repeat(32))).is_err());
    }

    #[test]
    fn name_rejects_path_traversal_and_separators() {
        assert_eq!(name("  report.pdf  ").unwrap(), "report.pdf");
        for bad in [".", "..", "a/b", "a\\b", "a\0b", "a\nb", "a\rb", ""] {
            assert!(name(bad).is_err(), "should reject {bad:?}");
        }
        // 255 字符 OK，256 不行
        assert!(name(&"a".repeat(MAX_ATTACHMENT_NAME_CHARS)).is_ok());
        assert!(name(&"a".repeat(MAX_ATTACHMENT_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn mime_normalizes_and_validates_shape() {
        assert_eq!(mime("  Image/PNG  ").unwrap(), "image/png");
        assert_eq!(mime("application/pdf").unwrap(), "application/pdf");
        // type/subtype 形状
        for bad in ["", "noSlash", "/subtype", "type/", "a/b/c"] {
            assert!(mime(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn kind_is_restricted() {
        for good in ATTACHMENT_KINDS {
            assert!(kind(good).is_ok());
        }
        assert!(kind("video").is_err());
        assert!(kind("").is_err());
    }

    // ── 嗅探 ──────────────────────────────────────────────────────────────

    #[test]
    fn sniffs_common_magic_numbers() {
        assert_eq!(sniff_known_mime(b"\x89PNG\r\n\x1a\n..."), "image/png");
        assert_eq!(sniff_known_mime(b"\xff\xd8\xff\xe0..."), "image/jpeg");
        assert_eq!(sniff_known_mime(b"GIF87a..."), "image/gif");
        assert_eq!(sniff_known_mime(b"GIF89a..."), "image/gif");
        assert_eq!(sniff_known_mime(b"BM..."), "image/bmp");
        assert_eq!(sniff_known_mime(b"RIFF\0\0\0\0WEBP..."), "image/webp");
        assert_eq!(sniff_known_mime(b"%PDF-1.7..."), "application/pdf");
        assert_eq!(sniff_known_mime(b"PK\x03\x04..."), "application/zip");
        assert_eq!(sniff_known_mime(b"\x1f\x8b..."), "application/gzip");
        assert_eq!(sniff_known_mime("hello 世界".as_bytes()), "text/plain");
        assert_eq!(sniff_known_mime(&[0u8, 1, 2]), "application/octet-stream");
    }

    #[test]
    fn webp_requires_full_riff_header() {
        // 只有 RIFF 不够，还要第 8..12 字节是 WEBP
        assert_eq!(sniff_known_mime(b"RIFF\0\0\0\0AVI "), "application/octet-stream");
        assert_eq!(sniff_known_mime(b"RIFF\0\0\0\0WEBP"), "image/webp");
        // 长度不足 12
        assert_eq!(sniff_known_mime(b"RIFF\0\0"), "application/octet-stream");
    }

    // ── mime 与 kind 一致性 ───────────────────────────────────────────────

    #[test]
    fn image_requires_exact_magic_match() {
        let png = b"\x89PNG\r\n\x1a\n1234";
        assert!(validate_mime_and_kind(png, "image", "image/png").is_ok());
        // 声明 jpeg 但字节是 png
        assert_eq!(
            validate_mime_and_kind(png, "image", "image/jpeg")
                .unwrap_err()
                .message,
            "image bytes do not match the declared MIME type"
        );
        // 声明非 image/
        assert!(validate_mime_and_kind(png, "image", "application/pdf").is_err());
    }

    #[test]
    fn pdf_kind_is_strict() {
        let pdf = b"%PDF-1.7\n...";
        assert!(validate_mime_and_kind(pdf, "pdf", "application/pdf").is_ok());
        // 字节不是 PDF
        let not_pdf = b"\x89PNG\r\n\x1a\n";
        assert_eq!(
            validate_mime_and_kind(not_pdf, "pdf", "application/pdf")
                .unwrap_err()
                .message,
            "PDF bytes do not match application/pdf"
        );
        // mime 不是 pdf
        assert!(validate_mime_and_kind(pdf, "pdf", "image/png").is_err());
    }

    #[test]
    fn file_kind_rejects_image_and_pdf_mimes() {
        // 通用 kind 不能声明 image/pdf 类型
        assert_eq!(
            validate_mime_and_kind(b"whatever", "file", "image/png")
                .unwrap_err()
                .message,
            "image and PDF MIME types require their matching kind"
        );
        assert_eq!(
            validate_mime_and_kind(b"whatever", "file", "application/pdf")
                .unwrap_err()
                .message,
            "image and PDF MIME types require their matching kind"
        );
    }

    #[test]
    fn file_kind_keeps_text_strict() {
        // text/* 必须嗅探成 text/plain
        assert_eq!(
            validate_mime_and_kind(b"\x00\x01binary", "file", "text/plain")
                .unwrap_err()
                .message,
            "text bytes do not match the declared MIME type"
        );
        // 真文本 OK
        assert!(validate_mime_and_kind("hello".as_bytes(), "file", "text/plain").is_ok());
    }

    #[test]
    fn file_kind_allows_container_formats() {
        // 上游取舍：DOCX 之类是 ZIP magic，不能因为 magic 是 zip 就拒绝
        let docx = b"PK\x03\x04docx-payload";
        assert!(validate_mime_and_kind(
            docx,
            "file",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        .is_ok());
        assert!(validate_mime_and_kind(b"\x1f\x8b...", "file", "application/gzip").is_ok());
        assert!(validate_mime_and_kind(b"\x00\xff", "file", "application/octet-stream").is_ok());
    }

    // ── base64 ────────────────────────────────────────────────────────────

    #[test]
    fn base64_round_trips() {
        let data = b"hello world";
        let encoded = encode_content_base64(data);
        assert_eq!(decode_content_base64(&encoded).unwrap(), data);
    }

    #[test]
    fn base64_rejects_data_urls() {
        assert_eq!(
            decode_content_base64("data:text/plain;base64,aGVsbG8=")
                .unwrap_err()
                .message,
            "data URLs are not accepted"
        );
        // 前导空白也要识别
        assert!(decode_content_base64("  DATA:text/plain;base64,x").is_err());
    }

    #[test]
    fn base64_rejects_invalid_and_empty() {
        assert_eq!(
            decode_content_base64("").unwrap_err().message,
            "content_base64 is required"
        );
        assert_eq!(
            decode_content_base64("!!!not base64!!!").unwrap_err().message,
            "content_base64 is not valid base64"
        );
    }

    #[test]
    fn base64_rejects_oversized_payload() {
        // 构造超过 MAX_ATTACHMENT_BYTES 的数据
        let big = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        let encoded = encode_content_base64(&big);
        let err = decode_content_base64(&encoded).unwrap_err();
        assert_eq!(err.message, "attachment exceeds the per-file size limit");
    }

    // ── 清单 ──────────────────────────────────────────────────────────────

    fn manifest_entry(id_suffix: &str, size: i64) -> Value {
        json!({
            "attachment_id": format!("att_{}", id_suffix.repeat(32)),
            "kind": "file",
            "name": "report.pdf",
            "size": size,
            "mime": "application/pdf",
        })
    }

    #[test]
    fn manifest_entry_round_trips() {
        let value = json!({
            "attachment_id": format!("att_{}", "a".repeat(32)),
            "kind": "image",
            "name": "photo.png",
            "size": 1234,
            "mime": "image/png",
        });
        let entry = safe_manifest_entry(&value).unwrap();
        assert_eq!(entry.size, 1234);
        assert_eq!(entry.to_json(), value);
    }

    #[test]
    fn manifest_entry_rejects_bad_field_set() {
        let mut value = manifest_entry("a", 10);
        value["extra"] = json!(1);
        assert_eq!(
            safe_manifest_entry(&value).unwrap_err().message,
            "attachment entry fields are invalid"
        );
    }

    #[test]
    fn manifest_entry_rejects_bad_size() {
        // bool 不算整数
        let mut value = manifest_entry("a", 10);
        value["size"] = json!(true);
        assert!(safe_manifest_entry(&value).is_err());

        // 负数
        let mut value = manifest_entry("a", 10);
        value["size"] = json!(-1);
        assert!(safe_manifest_entry(&value).is_err());

        // 超单文件上限
        let mut value = manifest_entry("a", 10);
        value["size"] = json!(MAX_ATTACHMENT_BYTES as i64 + 1);
        assert!(safe_manifest_entry(&value).is_err());
    }

    #[test]
    fn manifest_bounds_count_and_total_bytes() {
        // 超过 8 个
        let items: Vec<Value> = (0..=MAX_ATTACHMENTS_PER_MESSAGE)
            .map(|i| manifest_entry(&format!("{:x}", i % 16), 1))
            .collect();
        assert_eq!(
            validate_manifest(&json!(items)).unwrap_err().message,
            "too many attachments"
        );

        // 总数超 per-message 上限
        let big = (MAX_MESSAGE_ATTACHMENT_BYTES / 2 + 1) as i64;
        let items = vec![manifest_entry("a", big), manifest_entry("b", big)];
        assert_eq!(
            validate_manifest(&json!(items)).unwrap_err().message,
            "attachments exceed the per-message size limit"
        );
    }

    #[test]
    fn manifest_rejects_duplicate_ids() {
        let items = vec![manifest_entry("a", 1), manifest_entry("a", 2)];
        assert_eq!(
            validate_manifest(&json!(items)).unwrap_err().message,
            "attachment is duplicated"
        );
    }

    #[test]
    fn manifest_accepts_valid_list() {
        let items = vec![manifest_entry("a", 100), manifest_entry("b", 200)];
        let entries = validate_manifest(&json!(items)).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn constants_match_upstream() {
        assert_eq!(MAX_ATTACHMENTS_PER_MESSAGE, 8);
        assert_eq!(MAX_ATTACHMENT_BYTES, 15_000_000);
        assert_eq!(MAX_MESSAGE_ATTACHMENT_BYTES, 25_000_000);
        assert_eq!(ATTACHMENT_KINDS.len(), 3);
    }
}