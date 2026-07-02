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
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const SOCKET_PATH: &str = "/tmp/shunt.sock";
const LOCK_PATH: &str = "/tmp/shunt.sock.lock";
const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MiB (Chrome caps at 1 MiB)

fn is_native_messaging_launch() -> bool {
    std::env::args().any(|arg| arg.starts_with("chrome-extension://"))
}

fn manual_host_allowed() -> bool {
    std::env::var("SHUNT_ALLOW_MANUAL_HOST").is_ok_and(|value| value == "1")
}

fn acquire_socket_lock(is_native: bool) -> File {
    if !is_native && !manual_host_allowed() {
        eprintln!(
            "shunt-host: refusing manual launch; start Helium with the Shunt extension instead \
             (set SHUNT_ALLOW_MANUAL_HOST=1 for transport debugging)"
        );
        std::process::exit(1);
    }

    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(true)
        .open(LOCK_PATH)
        .expect("open socket lock");

    let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        eprintln!("shunt-host: another host owns {LOCK_PATH}; exiting");
        std::process::exit(1);
    }

    lock.set_len(0).expect("truncate socket lock");
    writeln!(&lock, "{}\t{}", std::process::id(), if is_native { "native" } else { "manual" })
        .expect("write socket lock owner");
    lock
}

fn bind_socket() -> UnixListener {
    // The flock above is the ownership primitive. Once held, no other host can
    // concurrently probe/unlink/bind this socket path.
    match std::fs::remove_file(SOCKET_PATH) {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => panic!("remove stale Unix socket: {err}"),
    }
    thread::sleep(Duration::from_millis(10));
    UnixListener::bind(SOCKET_PATH).expect("bind Unix socket")
}

fn main() {
    let is_native = is_native_messaging_launch();
    let _socket_lock = acquire_socket_lock(is_native);
    let listener = bind_socket();
    let clients: Arc<Mutex<Vec<(usize, std::os::unix::net::UnixStream)>>> =
        Arc::new(Mutex::new(Vec::new()));
    let next_client_id = Arc::new(AtomicUsize::new(1));
    let stdout: Arc<Mutex<std::io::Stdout>> = Arc::new(Mutex::new(std::io::stdout()));

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
            let write_stream = stream.try_clone().expect("clone stream");
            let read_stream = stream;

            let client_id = next_client_id_accept.fetch_add(1, Ordering::Relaxed);
            clients_accept.lock().unwrap().push((client_id, write_stream));

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
                            let mut out = stdout.lock().unwrap();
                            // Write 4-byte length prefix (native byte order) + message body
                            out.write_all(&len.to_ne_bytes()).ok();
                            out.write_all(msg).ok();
                            out.flush().ok();
                        }
                    }
                }
                clients_cleanup.lock().unwrap().retain(|(id, _)| *id != client_id);
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
        let mut clients = clients.lock().unwrap();
        clients.retain_mut(|(_, c)| {
            c.write_all(&body).and_then(|_| c.write_all(b"\n")).is_ok()
        });
    }

    // stdin closed → cleanup
    let _ = std::fs::remove_file(SOCKET_PATH);
}
