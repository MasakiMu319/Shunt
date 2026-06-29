// Shunt Native Host — pure transport pipe between Helium Extension and CLI
//
// Data flow:
//   stdin (4-byte len prefix + JSON) → broadcast to all Unix socket clients (JSON + \n)
//   Unix socket client (JSON line)    → stdout (4-byte len prefix + JSON)
//
// Knows nothing about message content. Does not parse JSON.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use std::thread;

const SOCKET_PATH: &str = "/tmp/shunt.sock";
const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MiB (Chrome caps at 1 MiB)

fn bind_socket() -> UnixListener {
    match UnixListener::bind(SOCKET_PATH) {
        Ok(listener) => return listener,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            // Do not blindly unlink a live socket: a second manually-started host
            // would steal /tmp/shunt.sock from the Chrome-spawned Native Messaging
            // host and turn the CLI connection into a black hole.
            match UnixStream::connect(SOCKET_PATH) {
                Ok(_) => {
                    eprintln!(
                        "shunt-host: {SOCKET_PATH} is already served by another live host; exiting"
                    );
                    std::process::exit(1);
                }
                Err(connect_err) => {
                    eprintln!(
                        "shunt-host: removing stale socket {SOCKET_PATH} ({connect_err})"
                    );
                    std::fs::remove_file(SOCKET_PATH).expect("remove stale Unix socket");
                }
            }
        }
        Err(err) => panic!("bind Unix socket: {err}"),
    }

    UnixListener::bind(SOCKET_PATH).expect("bind Unix socket after stale cleanup")
}

fn main() {
    let listener = bind_socket();
    let clients: Arc<Mutex<Vec<std::os::unix::net::UnixStream>>> =
        Arc::new(Mutex::new(Vec::new()));
    let stdout: Arc<Mutex<std::io::Stdout>> = Arc::new(Mutex::new(std::io::stdout()));

    // ── Accept thread: accept socket connections, spawn per-client reader ──
    let clients_accept = clients.clone();
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

            clients_accept.lock().unwrap().push(write_stream);

            // Per-client reader: socket → stdout, adding 4-byte native-endian length prefix
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
        clients.retain(|mut c| {
            c.write_all(&body).and_then(|_| c.write_all(b"\n")).is_ok()
        });
    }

    // stdin closed → cleanup
    let _ = std::fs::remove_file(SOCKET_PATH);
}
