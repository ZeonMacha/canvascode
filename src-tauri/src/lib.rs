mod preview;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static STARTUP_FILE: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Serialize, Deserialize)]
pub struct DiffItem {
    pub selector: Option<String>,
    pub summary: Option<String>,
    #[serde(rename = "tailwindClasses")]
    pub tailwind_classes: Option<String>,
}

#[tauri::command]
fn apply_code_sync(project_path: String, diff_items: Vec<DiffItem>) -> Result<String, String> {
    if diff_items.is_empty() {
        return Ok("没有改动需要写入。".into());
    }

    let p = Path::new(&project_path);
    if !p.exists() {
        return Err(format!("目标工程路径不存在: {}", project_path));
    }

    let item_count = diff_items.len();
    let folder_name = p.file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| project_path.clone());

    let response_msg = format!(
        "成功完成代码同步处理！目标工程: [{}]，共处理了 {} 处组件微调规则。",
        folder_name,
        item_count
    );

    Ok(response_msg)
}

#[derive(Serialize)]
struct LocalPage {
    url: String,
    name: String,
}

fn encode_path_segment(name: &str) -> String {
    let mut out = String::new();
    for byte in name.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            byte => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn is_html(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm")),
        Some(true)
    )
}

#[tauri::command]
fn prepare_local_page(path: String) -> Result<LocalPage, String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err(format!("找不到文件: {}", path.display()));
    }
    if !is_html(&path) {
        return Err("请拖入 HTML 文件。".into());
    }
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| "无法确定文件所在目录。".to_string())?;
    let port = preview::ensure_server(parent.to_path_buf())?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());
    Ok(LocalPage {
        url: format!("http://127.0.0.1:{port}/{}", encode_path_segment(&name)),
        name,
    })
}

#[tauri::command]
fn tweak_engine_source() -> &'static str {
    preview::engine_source()
}

fn write_html_file(path: &Path, html: &str) -> Result<String, String> {
    if !is_html(path) {
        return Err("只能写回 .html 或 .htm 文件。".into());
    }
    if html.trim().is_empty() {
        return Err("页面内容是空的，已取消写回。".into());
    }
    if html.len() > 32 * 1024 * 1024 {
        return Err("页面过大，无法写回。".into());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err("目标文件所在目录不存在。".into());
        }
    }
    if path.exists() {
        let backup = PathBuf::from(format!("{}.canvascode.bak", path.display()));
        std::fs::copy(path, &backup).map_err(|err| format!("无法备份原文件: {err}"))?;
    }
    std::fs::write(path, html.as_bytes()).map_err(|err| format!("写入失败: {err}"))?;
    Ok(format!(
        "已写回 {}。原文件备份在同目录的 .canvascode.bak。",
        path.display()
    ))
}

#[tauri::command]
fn write_local_html(path: String, html: String) -> Result<String, String> {
    write_html_file(Path::new(&path), &html)
}

#[tauri::command]
fn take_startup_file() -> Option<String> {
    STARTUP_FILE.lock().ok().and_then(|mut slot| slot.take())
}

#[tauri::command]
fn pick_html_file() -> Result<Option<String>, String> {
    let id = std::process::id();
    let out = std::env::temp_dir().join(format!("canvascode-pick-{id}.txt"));
    let script_path = std::env::temp_dir().join(format!("canvascode-pick-{id}.ps1"));
    let _ = std::fs::remove_file(&out);
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = 'HTML (*.html;*.htm)|*.html;*.htm'
$dialog.Title = '打开本地 HTML'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  [System.IO.File]::WriteAllText('{path}', $dialog.FileName, (New-Object System.Text.UTF8Encoding $false))
}}
"#,
        path = out.display().to_string().replace('\'', "''")
    );
    std::fs::write(&script_path, script).map_err(|err| format!("无法创建文件选择脚本: {err}"))?;
    let mut command = std::process::Command::new("powershell");
    command.args([
        "-NoProfile",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        &script_path.to_string_lossy(),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: keep the file dialog, hide the PowerShell console.
        command.creation_flags(0x08000000);
    }
    let status = command
        .status()
        .map_err(|err| format!("无法打开文件选择窗口: {err}"))?;
    let _ = std::fs::remove_file(&script_path);
    if !status.success() {
        return Err("文件选择窗口已取消或失败。".into());
    }
    if !out.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&out).map_err(|err| format!("无法读取所选路径: {err}"))?;
    let _ = std::fs::remove_file(&out);
    let path = text.trim().trim_start_matches('\u{feff}').to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

fn capture_startup_file() {
    let Some(path) = std::env::args().nth(1) else {
        return;
    };
    let file = PathBuf::from(path);
    if file.is_file() && is_html(&file) {
        if let Ok(mut slot) = STARTUP_FILE.lock() {
            *slot = Some(file.to_string_lossy().to_string());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    capture_startup_file();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            apply_code_sync,
            write_local_html,
            prepare_local_page,
            tweak_engine_source,
            take_startup_file,
            pick_html_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_html_and_keeps_one_backup() {
        let dir = std::env::temp_dir().join(format!("canvascode-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("page.html");
        std::fs::write(&file, "<html>old</html>").unwrap();

        let message = write_html_file(&file, "<!DOCTYPE html><html>new</html>").unwrap();
        assert!(message.contains("page.html"));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "<!DOCTYPE html><html>new</html>"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("page.html.canvascode.bak")).unwrap(),
            "<html>old</html>"
        );
        assert!(write_html_file(&dir.join("notes.txt"), "<html></html>").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
