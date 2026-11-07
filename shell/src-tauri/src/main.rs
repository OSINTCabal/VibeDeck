//! VibeDeck native shell (Tauri 2).
//!
//! Spawns the Python sidecar (uvicorn serving the SPA + API on 127.0.0.1:9377)
//! and opens a native window pointed at it. The sidecar is a child process: it is
//! killed when the window closes. This gives a real desktop app (~10 MB AppImage
//! via WebKitGTK) instead of a Chrome app-mode window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};

struct Sidecar(Mutex<Option<Child>>);

fn sidecar_cmd() -> Command {
    // Resolve the sidecar: env override, then repo layout, then installed layout.
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        std::env::var("VIBEDECK_HOME").unwrap_or_default(),
        format!("{}/.local/share/vibedeck", home),
    ];
    for base in candidates {
        if !base.is_empty() {
            let py = format!("{}/.venv/bin/python", base);
            let srv = format!("{}/sidecar/vibedeck_server.py", base);
            if std::path::Path::new(&srv).exists() {
                let mut c = Command::new(&py);
                c.arg("-m").arg("uvicorn")
                    .arg("vibedeck_server:app")
                    .arg("--app-dir").arg(format!("{}/sidecar", base))
                    .arg("--host").arg("127.0.0.1").arg("--port").arg("9377")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                return c;
            }
        }
    }
    // fallback: repo layout relative to the executable's cwd
    let mut c = Command::new("python3");
    c.arg("-m").arg("uvicorn").arg("vibedeck_server:app")
        .arg("--host").arg("127.0.0.1").arg("--port").arg("9377");
    c
}

fn main() {
    // Spawn the sidecar before building the app.
    let address = "127.0.0.1:9377".parse().expect("valid sidecar address");
    let child = if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(200)).is_ok() {
        None
    } else {
        let child = sidecar_cmd().spawn().expect("Cannot start VibeDeck sidecar; install it first");
        for _ in 0..100 {
            if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(100)).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Some(child)
    };

    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(child)))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // kill the sidecar child on quit
                if let Some(state) = window.app_handle().try_state::<Sidecar>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running VibeDeck");
}
