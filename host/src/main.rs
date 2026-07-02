// Shunt Native Host — pure transport pipe between Helium Extension and CLI
//
// Data flow:
//   stdin (4-byte len prefix + JSON) → broadcast to all Unix socket clients (JSON + \n)
//   Unix socket client (JSON line)    → stdout (4-byte len prefix + JSON)
//
// Knows nothing about message content. Does not parse JSON.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const SOCKET_FILE_NAME: &str = "shunt.sock";
const LOCK_FILE_NAME: &str = "shunt.sock.lock";
const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MiB (Chrome caps at 1 MiB)

fn fatal(message: impl std::fmt::Display) -> ! {
    eprintln!("shunt-host: {message}");
    std::process::exit(1);
}

fn is_native_messaging_launch() -> bool {
    std::env::args().any(|arg| arg.starts_with("chrome-extension://"))
}

fn manual_host_allowed() -> bool {
    std::env::var("SHUNT_ALLOW_MANUAL_HOST").is_ok_and(|value| value == "1")
}

fn default_runtime_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SHUNT_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Library/Application Support/Shunt");
    }
    std::env::temp_dir().join("Shunt")
}

fn socket_path() -> PathBuf {
    std::env::var("SHUNT_SOCKET_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_runtime_dir().join(SOCKET_FILE_NAME))
}

fn lock_path(socket_path: &Path) -> PathBuf {
    if std::env::var("SHUNT_SOCKET_PATH").is_ok() {
        return PathBuf::from(format!("{}.lock", socket_path.display()));
    }
    default_runtime_dir().join(LOCK_FILE_NAME)
}

#[derive(Clone, Copy)]
struct SocketIdentity {
    dev: u64,
    ino: u64,
}

fn socket_identity(path: &Path) -> Option<SocketIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    Some(SocketIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
    })
}

fn remove_socket_if_owned(path: &Path, identity: Option<SocketIdentity>) {
    let Some(expected) = identity else { return };
    let Some(current) = socket_identity(path) else {
        return;
    };
    if current.dev == expected.dev && current.ino == expected.ino {
        let _ = std::fs::remove_file(path);
    }
}

fn acquire_socket_lock(lock_path: &Path, is_native: bool) -> File {
    if !is_native && !manual_host_allowed() {
        eprintln!(
            "shunt-host: refusing manual launch; start Helium with the Shunt extension instead \
             (set SHUNT_ALLOW_MANUAL_HOST=1 for transport debugging)"
        );
        std::process::exit(1);
    }

    if let Some(parent) = lock_path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            fatal(format!("create Shunt runtime directory: {err}"));
        }
    }

    let lock = match OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(true)
        .open(lock_path)
    {
        Ok(lock) => lock,
        Err(err) => fatal(format!("open socket lock: {err}")),
    };

    let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        fatal(format!(
            "another host owns {}; exiting",
            lock_path.display()
        ));
    }

    if let Err(err) = lock.set_len(0) {
        fatal(format!("truncate socket lock: {err}"));
    }
    if let Err(err) = writeln!(
        &lock,
        "{}\t{}",
        std::process::id(),
        if is_native { "native" } else { "manual" }
    ) {
        fatal(format!("write socket lock owner: {err}"));
    }
    lock
}

fn bind_socket(socket_path: &Path) -> (UnixListener, Option<SocketIdentity>) {
    // The flock above is the ownership primitive. Once held, no other host can
    // concurrently probe/unlink/bind this socket path.
    if let Some(parent) = socket_path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            fatal(format!("create Shunt runtime directory: {err}"));
        }
    }
    match std::fs::remove_file(socket_path) {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => fatal(format!("remove stale Unix socket: {err}")),
    }
    thread::sleep(Duration::from_millis(10));
    let listener = match UnixListener::bind(socket_path) {
        Ok(listener) => listener,
        Err(err) => fatal(format!("bind Unix socket: {err}")),
    };
    let identity = socket_identity(socket_path);
    (listener, identity)
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if c.is_control() => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped
}

fn write_native_message(stdout: &Arc<Mutex<std::io::Stdout>>, message: &str) {
    let len = message.len() as u32;
    let Ok(mut out) = stdout.lock() else { return };
    out.write_all(&len.to_ne_bytes()).ok();
    out.write_all(message.as_bytes()).ok();
    out.flush().ok();
}

fn send_host_ready(stdout: &Arc<Mutex<std::io::Stdout>>, socket_path: &Path) {
    let socket_path = json_escape(&socket_path.display().to_string());
    let message = format!(
        "{{\"jsonrpc\":\"2.0\",\"method\":\"hostReady\",\"params\":{{\"pid\":{},\"socketPath\":\"{}\"}}}}",
        std::process::id(),
        socket_path,
    );
    write_native_message(stdout, &message);
}

fn main() {
    let is_native = is_native_messaging_launch();
    let socket_path = socket_path();
    let lock_path = lock_path(&socket_path);
    let _socket_lock = acquire_socket_lock(&lock_path, is_native);
    let (listener, socket_identity) = bind_socket(&socket_path);
    let clients: Arc<Mutex<Vec<(usize, std::os::unix::net::UnixStream)>>> =
        Arc::new(Mutex::new(Vec::new()));
    let next_client_id = Arc::new(AtomicUsize::new(1));
    let stdout: Arc<Mutex<std::io::Stdout>> = Arc::new(Mutex::new(std::io::stdout()));
    send_host_ready(&stdout, &socket_path);

    // ── Accept thread: accept socket connections, spawn per-client reader ──
    let clients_accept = clients.clone();
    let next_client_id_accept = next_client_id.clone();
    let stdout_accept = stdout.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(s) => s,
                Err(_) => break, // listener closed or shutdown
            };

            // Clone write end for broadcast list, keep read end for this thread
            let write_stream = match stream.try_clone() {
                Ok(stream) => stream,
                Err(err) => {
                    eprintln!("shunt-host: clone client stream failed: {err}");
                    continue;
                }
            };
            let read_stream = stream;

            let client_id = next_client_id_accept.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut clients) = clients_accept.lock() {
                clients.push((client_id, write_stream));
            } else {
                eprintln!("shunt-host: clients mutex poisoned");
                continue;
            }

            // Per-client reader: socket → stdout, adding 4-byte native-endian length prefix
            let clients_cleanup = clients_accept.clone();
            let stdout = stdout_accept.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(read_stream);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break, // EOF or error → client disconnected
                        Ok(_) => {
                            let msg = line.trim_end().as_bytes();
                            if msg.is_empty() {
                                continue;
                            }
                            let len = msg.len() as u32;
                            let Ok(mut out) = stdout.lock() else { break };
                            // Write 4-byte length prefix (native byte order) + message body
                            out.write_all(&len.to_ne_bytes()).ok();
                            out.write_all(msg).ok();
                            out.flush().ok();
                        }
                    }
                }
                if let Ok(mut clients) = clients_cleanup.lock() {
                    clients.retain(|(id, _)| *id != client_id);
                }
            });
        }
    });

    // ── Main thread: stdin → broadcast to all socket clients ──
    let mut stdin = std::io::stdin();
    let mut len_buf = [0u8; 4];

    loop {
        // Read 4-byte length prefix (native byte order = little-endian on macOS)
        if stdin.read_exact(&mut len_buf).is_err() {
            break; // stdin closed → Extension disconnected or process dying
        }
        let msg_len = u32::from_ne_bytes(len_buf) as usize;

        // Safety limit
        if msg_len > MAX_MESSAGE_SIZE {
            eprintln!("shunt-host: message too large ({msg_len} bytes), exiting");
            break;
        }

        // Read message body
        let mut body = vec![0u8; msg_len];
        if stdin.read_exact(&mut body).is_err() {
            break;
        }

        // Broadcast to all connected socket clients (append newline for line-based reading)
        let Ok(mut clients) = clients.lock() else {
            break;
        };
        clients.retain_mut(|(_, c)| c.write_all(&body).and_then(|_| c.write_all(b"\n")).is_ok());
    }

    // stdin closed → cleanup
    remove_socket_if_owned(&socket_path, socket_identity);
}
