use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

const ENGINE_ROUTE: &str = "/__canvascode__/tweak-engine.js";
const ENGINE_JS: &str = include_str!("../../tweak-engine.js");

pub fn engine_source() -> &'static str {
    ENGINE_JS
}

struct Server {
    port: u16,
    root: PathBuf,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);

pub fn ensure_server(root: PathBuf) -> Result<u16, String> {
    let root = root
        .canonicalize()
        .map_err(|err| format!("无法访问页面所在目录: {err}"))?;
    let mut slot = SERVER.lock().map_err(|_| "预览服务忙".to_string())?;
    if let Some(server) = slot.as_mut() {
        server.root = root;
        return Ok(server.port);
    }

    let listener = TcpListener::bind("127.0.0.1:47321")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|err| format!("无法启动本地预览: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| err.to_string())?
        .port();
    *slot = Some(Server {
        port,
        root: root.clone(),
    });
    drop(slot);

    thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            thread::spawn(move || {
                let _ = handle_client(conn);
            });
        }
    });
    Ok(port)
}

pub fn current_root() -> Option<PathBuf> {
    SERVER
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|server| server.root.clone()))
}

fn handle_client(mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = [0_u8; 8192];
    let n = stream.read(&mut buf).unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..n]);
    let mut lines = request.lines();
    let Some(start) = lines.next() else {
        return write_status(&mut stream, 400, "text/plain; charset=utf-8", b"bad request");
    };
    let mut parts = start.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return write_status(&mut stream, 405, "text/plain; charset=utf-8", b"method not allowed");
    }

    if target.split('?').next().unwrap_or("") == ENGINE_ROUTE {
        let body = if method == "HEAD" { Vec::new() } else { ENGINE_JS.as_bytes().to_vec() };
        return write_bytes(&mut stream, 200, "text/javascript; charset=utf-8", &body);
    }

    let Some(root) = current_root() else {
        return write_status(&mut stream, 404, "text/plain; charset=utf-8", b"not found");
    };
    let file = match resolve_under(&root, target) {
        Ok(path) => path,
        Err(404) => {
            return write_status(&mut stream, 404, "text/plain; charset=utf-8", b"not found")
        }
        Err(_) => {
            return write_status(&mut stream, 403, "text/plain; charset=utf-8", b"forbidden")
        }
    };

    let bytes = match std::fs::read(&file) {
        Ok(bytes) if bytes.len() <= 32 * 1024 * 1024 => bytes,
        Ok(_) => {
            return write_status(&mut stream, 413, "text/plain; charset=utf-8", b"file too large")
        }
        Err(_) => return write_status(&mut stream, 404, "text/plain; charset=utf-8", b"not found"),
    };
    let kind = content_type(&file);
    let mut body = if kind.starts_with("text/html") {
        match String::from_utf8(bytes) {
            Ok(html) => inject_engine(html).into_bytes(),
            Err(err) => err.into_bytes(),
        }
    } else {
        bytes
    };
    if method == "HEAD" {
        body.clear();
    }
    write_bytes(&mut stream, 200, kind, &body)
}

pub fn resolve_under(root: &Path, url_path: &str) -> Result<PathBuf, u16> {
    let raw = url_path.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(raw).ok_or(400_u16)?;
    let relative = decoded.trim_start_matches(['/', '\\']);
    if relative.is_empty() {
        return Err(404);
    }
    let mut clean = PathBuf::new();
    for part in Path::new(relative).components() {
        match part {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(403),
        }
    }
    let candidate = root.join(&clean);
    let file = candidate.canonicalize().map_err(|_| 404_u16)?;
    if !file.starts_with(root) || !file.is_file() {
        return Err(403);
    }
    Ok(file)
}

pub fn inject_engine(html: String) -> String {
    if html.contains("canvascode-engine-script") {
        return html;
    }
    let tag = r#"<script id="canvascode-engine-script" src="/__canvascode__/tweak-engine.js" defer></script>"#;
    let lower = html.to_ascii_lowercase();
    if let Some(index) = lower.rfind("</body>") {
        let mut out = String::with_capacity(html.len() + tag.len());
        out.push_str(&html[..index]);
        out.push_str(tag);
        out.push_str(&html[index..]);
        return out;
    }
    html + tag
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1])?;
                let low = hex_value(bytes[index + 2])?;
                out.push((high << 4) | low);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn write_status(stream: &mut TcpStream, status: u16, kind: &str, body: &[u8]) -> std::io::Result<()> {
    write_bytes(stream, status, kind, body)
}

fn write_bytes(stream: &mut TcpStream, status: u16, kind: &str, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http_get(port: u16, path: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let text = String::from_utf8_lossy(&raw);
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or(("", ""));
        let status = head
            .split_whitespace()
            .nth(1)
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        (status, body.to_string())
    }

    #[test]
    fn serves_html_neighbors_and_blocks_escape() {
        let dir = std::env::temp_dir().join(format!("canvascode-preview-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("at2-matter")).unwrap();
        std::fs::write(dir.join("page.html"), "<html><body><p>ok</p></body></html>").unwrap();
        std::fs::write(dir.join("at2-matter").join("app.js"), "window.MATTERS=[]").unwrap();
        let outside = std::env::temp_dir().join(format!("canvascode-secret-{}.txt", std::process::id()));
        std::fs::write(&outside, "secret").unwrap();

        let port = ensure_server(dir.clone()).unwrap();
        let (status, js) = http_get(port, "/at2-matter/app.js");
        assert_eq!(status, 200);
        assert!(js.contains("window.MATTERS"));

        let (status, html) = http_get(port, "/page.html");
        assert_eq!(status, 200);
        assert!(html.contains("canvascode-engine-script"));
        assert!(html.contains("<p>ok</p>"));

        let (status, _) = http_get(port, "/../canvascode-secret.txt");
        assert_ne!(status, 200);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }
}
