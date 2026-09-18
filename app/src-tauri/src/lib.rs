// Casca nativa do NitroCall. Toda a comunicação (WebRTC) vive no WebView; aqui ficam só as
// coisas que o navegador não sabe fazer: medir a CPU, impedir o Windows de dormir durante
// a chamada, gravar o registro em arquivo, bandeja, atalho global, link de convite e
// atualização automática.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use sysinfo::System;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Serialize)]
struct SystemLoad {
    cpu: f32,
    mem: f32,
}

static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

// Uso global de CPU e memória (0–100). O sysinfo precisa de duas amostras; a primeira
// chamada devolve 0 e as seguintes (a cada 2 s) o valor real.
#[tauri::command]
fn system_load() -> SystemLoad {
    let sys = SYSTEM.get_or_init(|| Mutex::new(System::new()));
    let mut sys = sys.lock().unwrap_or_else(|e| e.into_inner());
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let cpu = sys.global_cpu_usage();
    let total = sys.total_memory().max(1) as f32;
    let mem = 100.0 * sys.used_memory() as f32 / total;
    SystemLoad { cpu, mem }
}

static KEEP_AWAKE: AtomicBool = AtomicBool::new(false);
static KEEP_AWAKE_THREAD: OnceLock<()> = OnceLock::new();

// Impede o Windows de dormir (e de apagar a tela) enquanto a chamada estiver aberta: quem
// faz ponte para os amigos não pode cair porque o PC foi para o modo de espera.
#[tauri::command]
fn keep_awake(on: bool) {
    KEEP_AWAKE.store(on, Ordering::SeqCst);
    KEEP_AWAKE_THREAD.get_or_init(|| {
        std::thread::spawn(|| loop {
            #[cfg(windows)]
            {
                use windows_sys::Win32::System::Power::{
                    SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
                };
                // O estado vale por thread: esta thread dedicada renova a cada 30 s.
                let flags = if KEEP_AWAKE.load(Ordering::SeqCst) {
                    ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
                } else {
                    ES_CONTINUOUS
                };
                unsafe {
                    SetThreadExecutionState(flags);
                }
            }
            std::thread::sleep(Duration::from_secs(30));
        });
    });
}

const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

// Registro em arquivo (o mesmo que aparece no painel 🩺), com rotação simples, para o
// usuário mandar quando algo der errado.
#[tauri::command]
fn append_log(app: AppHandle, line: String) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("nitrocall.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > LOG_MAX_BYTES {
            let _ = fs::rename(&path, dir.join("nitrocall.1.log"));
        }
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let clean: String = line.chars().filter(|c| !c.is_control() || *c == '\t').take(4000).collect();
    writeln!(f, "{clean}").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn log_path(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("nitrocall.log").to_string_lossy().into_owned())
}

static IN_CALL: AtomicBool = AtomicBool::new(false);

// A tela diz se há chamada aberta: com chamada, fechar a janela só a esconde na bandeja.
#[tauri::command]
fn set_in_call(on: bool) {
    IN_CALL.store(on, Ordering::SeqCst);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let mute = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);
                    if shortcut == &mute {
                        let _ = app.emit("nitro:toggle-mute", ());
                    }
                })
                .build(),
        );

    #[cfg(any(windows, target_os = "linux"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        builder = builder.setup(|app| {
            // Registra nitrocall:// mesmo sem instalador (dev).
            let _ = app.deep_link().register_all();
            Ok(())
        });
    }

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = handle
                .global_shortcut()
                .register(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM));

            let show = MenuItem::with_id(app, "show", "Mostrar o NitroCall", true, None::<&str>)?;
            let mute = MenuItem::with_id(app, "mute", "Mutar / desmutar (Ctrl+Shift+M)", true, None::<&str>)?;
            let leave = MenuItem::with_id(app, "leave", "Sair da sala", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Fechar o NitroCall", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &mute, &leave, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("NitroCall — com segurança")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "mute" => {
                        let _ = app.emit("nitro:toggle-mute", ());
                    }
                    "leave" => {
                        let _ = app.emit("nitro:leave", ());
                        show_main(app);
                    }
                    "quit" => {
                        let _ = app.emit("nitro:leave", ());
                        std::thread::sleep(Duration::from_millis(300));
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Iniciado com o Windows em modo mínimo: fica só na bandeja.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if IN_CALL.load(Ordering::SeqCst) {
                    // Em chamada, fechar a janela só a esconde: a chamada (e a ponte)
                    // continua na bandeja.
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.app_handle().emit("nitro:hidden-to-tray", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            system_load,
            keep_awake,
            append_log,
            log_path,
            set_in_call
        ])
        .run(tauri::generate_context!())
        .expect("error while running nitrocall");
}
