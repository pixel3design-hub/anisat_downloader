// anisat-feed — riceve il feed dall'estensione AniSat Downloader, lo salva in
// ~/.anisatrss/feed.rss, lo serve su HTTP e mostra una piccola pagina di configurazione.
//
//   GET  /                 pagina di configurazione (interfaccia web)
//   GET  /config           configurazione in JSON
//   POST /config           aggiorna la configurazione (json parziale)
//   POST /feed             corpo = XML del feed (text/plain) -> scrive il file
//   GET  /feed.xml         feed (alias: /feed.rss)
//   GET  /status           JSON: stato, versione, aggiornamento disponibile
//   GET  /health           "ok"
//
// Su Linux l'icona nella barra dei programmi (ksni/D-Bus) apre la configurazione.

mod auth;
mod config;
mod download;
#[cfg(target_os = "linux")]
mod tray;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use std::sync::OnceLock;

use tiny_http::{Header, Method, Response, Server, StatusCode};

pub const BIND_DEFAULT: &str = "127.0.0.1:8787";
const FEED_NAME: &str = "feed.rss";
const UI_HTML: &str = include_str!("ui.html");

const REPO: &str = env!("CARGO_PKG_REPOSITORY");
const AUTHOR: &str = env!("CARGO_PKG_AUTHORS");
const LICENSE: &str = env!("CARGO_PKG_LICENSE");
const VERSION: &str = env!("CARGO_PKG_VERSION");
const RELEASES_URL: &str = "https://github.com/pixel3design-hub/anisat_downloader/releases";
const LATEST_API: &str =
    "https://api.github.com/repos/pixel3design-hub/anisat_downloader/releases/latest";

// --- stato condiviso -------------------------------------------------------

#[derive(Clone, Default)]
struct Status {
    bytes: u64,
    items: usize,
    updated_at: u64,
    latest: Option<String>,
    checked_at: u64,
    check_error: Option<String>,
}

struct App {
    dir: PathBuf,
    cfg: Mutex<config::Config>,
    status: Mutex<Status>,
    restart: AtomicBool,
    jobs: download::Jobs,
    sessions: auth::Sessions,
    #[cfg(target_os = "linux")]
    tray: OnceLock<ksni::blocking::Handle<tray::AniTray>>,
    #[cfg(target_os = "linux")]
    tray_snap: Arc<Mutex<tray::Snapshot>>,
}

impl App {
    fn new(dir: PathBuf, cfg: config::Config) -> App {
        App {
            dir,
            cfg: Mutex::new(cfg),
            status: Mutex::new(Status::default()),
            restart: AtomicBool::new(false),
            jobs: download::new_jobs(),
            sessions: auth::Sessions::new(),
            #[cfg(target_os = "linux")]
            tray: OnceLock::new(),
            #[cfg(target_os = "linux")]
            tray_snap: Arc::new(Mutex::new(tray::Snapshot::default())),
        }
    }

    fn feed_path(&self) -> PathBuf {
        self.dir.join(FEED_NAME)
    }

    fn name(&self) -> String {
        self.cfg.lock().unwrap().name.clone()
    }

    fn bind(&self) -> String {
        self.cfg.lock().unwrap().bind.clone()
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn default_data_dir() -> PathBuf {
    home_dir().join(".anisatrss")
}

// --- argomenti -------------------------------------------------------------

struct Args {
    headless: bool,
    data_dir: Option<PathBuf>,
    bind: Option<String>,
}

fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<Args, String> {
    let mut args = args.into_iter();
    let mut parsed = Args { headless: false, data_dir: None, bind: None };
    while let Some(a) = args.next() {
        match a.as_str() {
            "--headless" | "--no-tray" => parsed.headless = true,
            "--data-dir" => parsed.data_dir = Some(PathBuf::from(args.next().ok_or("--data-dir richiede un percorso")?)),
            "--bind" => parsed.bind = Some(args.next().ok_or("--bind richiede host:porta")?),
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            "-V" | "--version" => {
                println!("anisat-feed {VERSION} ({REPO})");
                process::exit(0);
            }
            other => return Err(format!("argomento sconosciuto: {other}")),
        }
    }
    Ok(parsed)
}

fn print_help() {
    println!(
        "anisat-feed {VERSION}\n\n\
         Riceve il feed RSS dall'estensione AniSat Downloader, lo salva e lo serve.\n\
         Di default parte con l'icona nella barra dei programmi.\n\n\
         USO:\n    anisat-feed [--headless] [--data-dir <cartella>] [--bind <host:porta>]\n\n\
         OPZIONI:\n    \
         --headless             nessuna icona nel tray (per systemd o uso da terminale)\n    \
         --data-dir <cartella>  dove salvare feed.rss e config.json (default: {})\n    \
         --bind <indirizzo>     indirizzo di ascolto (salvato in config.json)\n    \
         -h, --help             questo aiuto\n    \
         -V, --version          versione\n\n\
         PAGINA DI CONFIGURAZIONE:\n    http://<bind>/ · nome del feed, indirizzo, intervalli, aggiornamenti\n\n\
         REPOSITORIO:\n    {REPO}\n    segnalazioni: {REPO}/issues\n\n\
         AUTORE:\n    {AUTHOR}\n\n\
         LICENZA:\n    {LICENSE} — testo completo in COPYING\n",
        default_data_dir().display(),
    );
}

// --- feed su disco ---------------------------------------------------------

fn count_items(body: &str) -> usize {
    body.matches("<item>").count()
}

fn save_feed(app: &App, body: &str) -> Result<(usize, String), String> {
    let text = body.trim_start();
    if !(text.starts_with("<?xml") || text.starts_with("<rss")) || !text.contains("<rss") {
        return Err("il corpo non sembra un feed RSS".to_string());
    }
    let xml = config::rewrite_title(body, &app.name());
    fs::create_dir_all(&app.dir).map_err(|e| format!("impossibile creare {}: {e}", app.dir.display()))?;
    let tmp = app.dir.join(format!(".{FEED_NAME}.tmp"));
    fs::write(&tmp, &xml).map_err(|e| format!("scrittura fallita: {e}"))?;
    fs::rename(&tmp, app.feed_path()).map_err(|e| format!("rename fallito: {e}"))?;

    let mut st = app.status.lock().unwrap();
    st.bytes = xml.len() as u64;
    st.items = count_items(&xml);
    st.updated_at = now();
    Ok((xml.len(), app.feed_path().display().to_string()))
}

fn refresh_file_status(app: &App) {
    let mut st = app.status.lock().unwrap();
    match fs::metadata(app.feed_path()) {
        Ok(m) => {
            st.bytes = m.len();
            st.updated_at = m.modified().map(|t| t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)).unwrap_or(0);
            st.items = fs::read_to_string(app.feed_path()).map(|b| count_items(&b)).unwrap_or(0);
        }
        Err(_) => {
            st.bytes = 0;
            st.items = 0;
        }
    }
}

// --- controllo versione ----------------------------------------------------

fn fetch_latest() -> Result<String, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .build(),
    );
    let mut resp = agent
        .get(LATEST_API)
        .header("User-Agent", concat!("anisat-feed/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("GitHub: {e}"))?;
    let body = resp.body_mut().read_to_string().map_err(|e| format!("GitHub: {e}"))?;
    config::str_field(&body, "tag_name").ok_or_else(|| "tag_name assente nella risposta".to_string())
}

fn sync_tray(app: &Arc<App>) {
    #[cfg(target_os = "linux")]
    {
        let snapshot = {
            let st = app.status.lock().unwrap();
            tray::Snapshot {
                name: app.name(),
                bind: app.bind(),
                items: st.items,
                latest: st.latest.clone().filter(|l| config::is_newer(l, VERSION)),
                check_error: st.check_error.clone(),
            }
        };
        *app.tray_snap.lock().unwrap() = snapshot;
        if let Some(handle) = app.tray.get() {
            handle.update(|_| {});
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

fn spawn_checks(app: Arc<App>) {
    thread::spawn(move || loop {
        refresh_file_status(&app);
        let (mins, do_version) = {
            let c = app.cfg.lock().unwrap();
            (c.check_min.max(5), c.version_check)
        };
        if do_version {
            let result = fetch_latest();
            let mut st = app.status.lock().unwrap();
            st.checked_at = now();
            match result {
                Ok(tag) => {
                    st.latest = Some(tag);
                    st.check_error = None;
                }
                Err(e) => st.check_error = Some(e),
            }
        }
        sync_tray(&app);
        thread::sleep(Duration::from_secs(mins as u64 * 60));
    });
}

// --- HTTP ------------------------------------------------------------------

struct Reply {
    status: u16,
    ctype: &'static str,
    body: String,
    cookies: Vec<String>,
}

impl Reply {
    fn json(body: String) -> Reply {
        Reply { status: 200, ctype: "application/json; charset=utf-8", body, cookies: Vec::new() }
    }

    fn text(status: u16, body: String) -> Reply {
        Reply { status, ctype: "text/plain; charset=utf-8", body, cookies: Vec::new() }
    }

    fn status(mut self, status: u16) -> Reply {
        self.status = status;
        self
    }

    fn cookie(mut self, cookie: String) -> Reply {
        self.cookies.push(cookie);
        self
    }
}

fn status_json(app: &App) -> String {
    let st = app.status.lock().unwrap().clone();
    let cfg = app.cfg.lock().unwrap().clone();
    let latest = st.latest.clone();
    let available = latest.as_deref().map(|l| config::is_newer(l, VERSION)).unwrap_or(false);
    format!(
        "{{\"name\":\"{}\",\"bind\":\"{}\",\"path\":\"{}\",\"bytes\":{},\"items\":{},\"updated_at\":{},\
         \"version\":\"{}\",\"latest\":{},\"update_available\":{},\"checked_at\":{},\
         \"version_check\":{},\"version_check_error\":{},\"releases_url\":\"{}\",\"feed_url\":\"/feed.xml\"}}",
        config::escape(&cfg.name),
        config::escape(&cfg.bind),
        config::escape(&app.feed_path().display().to_string()),
        st.bytes,
        st.items,
        st.updated_at,
        VERSION,
        latest.map(|l| format!("\"{}\"", config::escape(&l))).unwrap_or_else(|| "null".into()),
        available,
        st.checked_at,
        cfg.version_check,
        st.check_error.map(|e| format!("\"{}\"", config::escape(&e))).unwrap_or_else(|| "null".into()),
        RELEASES_URL,
    )
}

fn apply_config(app: &App, body: &str) -> Reply {
    let (saved, bind, restarted) = {
        let mut cfg = app.cfg.lock().unwrap();
        let before = cfg.bind.clone();
        let changed = cfg.apply(body);
        if changed {
            if let Err(e) = cfg.save(&app.dir) {
                return Reply::json(format!("{{\"saved\":false,\"error\":\"{}\"}}", config::escape(&e))).status(500);
            }
        }
        let restarted = cfg.bind != before;
        if restarted {
            app.restart.store(true, Ordering::SeqCst);
        }
        (changed, cfg.bind.clone(), restarted)
    };
    Reply::json(format!(
        "{{\"saved\":{},\"bind\":\"{}\",\"restarted\":{}}}",
        saved,
        config::escape(&bind),
        restarted
    ))
}

fn authed(app: &App, cookie: Option<&str>) -> bool {
    auth::session_from_cookie(cookie).map(|t| app.sessions.valid(&t)).unwrap_or(false)
}

/// true finché la password è quella iniziale: la configurazione resta bloccata.
fn must_change(app: &App) -> bool {
    app.cfg.lock().unwrap().password.is_empty()
}

fn auth_json(app: &App, cookie: Option<&str>) -> String {
    let logged = authed(app, cookie);
    let mc = must_change(app);
    format!(
        "{{\"authenticated\":{logged},\"must_change\":{},\"default_password\":{}}}",
        mc,
        mc
    )
}

fn login(app: &App, body: &str) -> Reply {
    if app.sessions.locked() {
        return Reply::json("{\"ok\":false,\"error\":\"troppi tentativi, riprova tra 30 secondi\"}".into()).status(429);
    }
    let password = config::str_field(body, "password").unwrap_or_default();
    let stored = app.cfg.lock().unwrap().password.clone();
    let ok = if stored.is_empty() {
        auth::check_default(&password)
    } else {
        auth::verify_password(&stored, &password)
    };
    if !ok {
        app.sessions.register_failure();
        return Reply::json("{\"ok\":false,\"error\":\"password errata\"}".into()).status(401);
    }
    app.sessions.reset_failures();
    let token = app.sessions.create();
    Reply::json(format!("{{\"ok\":true,\"must_change\":{}}}", must_change(app))).cookie(auth::session_cookie(&token))
}

fn change_password(app: &App, body: &str) -> Reply {
    let current = config::str_field(body, "current").unwrap_or_default();
    let new = config::str_field(body, "new").unwrap_or_default();
    let stored = app.cfg.lock().unwrap().password.clone();
    let ok = if stored.is_empty() {
        auth::check_default(&current)
    } else {
        auth::verify_password(&stored, &current)
    };
    if !ok {
        return Reply::json("{\"ok\":false,\"error\":\"password attuale errata\"}".into()).status(401);
    }
    if let Some(reason) = auth::weak_password(&new) {
        return Reply::json(format!("{{\"ok\":false,\"error\":\"{}\"}}", config::escape(reason))).status(400);
    }
    let mut cfg = app.cfg.lock().unwrap();
    cfg.password = auth::hash_password(&new);
    if let Err(e) = cfg.save(&app.dir) {
        return Reply::json(format!("{{\"ok\":false,\"error\":\"{}\"}}", config::escape(&e))).status(500);
    }
    Reply::json("{\"ok\":true}".into())
}

fn handle(app: &App, method: &str, url: &str, body: Option<&str>, cookie: Option<&str>) -> Reply {
    let path = url.split('?').next().unwrap_or("/");

    // rotte di amministrazione: serve la sessione e la password cambiata
    let admin_block = || -> Option<Reply> {
        if !authed(app, cookie) {
            return Some(Reply::json("{\"error\":\"serve il login\"}".into()).status(401));
        }
        if must_change(app) {
            return Some(
                Reply::json("{\"error\":\"cambia la password iniziale\",\"must_change\":true}".into()).status(403),
            );
        }
        None
    };

    match (method, path) {
        ("OPTIONS", _) => Reply::text(204, String::new()),
        ("GET", "/health") => Reply::text(200, "ok\n".into()),
        ("GET", "/") | ("GET", "/ui") => Reply {
            status: 200,
            ctype: "text/html; charset=utf-8",
            body: UI_HTML.to_string(),
            cookies: Vec::new(),
        },
        ("GET", "/auth") => Reply::json(auth_json(app, cookie)),
        ("POST", "/login") => match body {
            Some(b) => login(app, b),
            None => Reply::json("{\"ok\":false,\"error\":\"corpo vuoto\"}".into()).status(400),
        },
        ("POST", "/logout") => {
            if let Some(t) = auth::session_from_cookie(cookie) {
                app.sessions.drop(&t);
            }
            Reply::json("{\"ok\":true}".into()).cookie(auth::clear_cookie())
        }
        ("POST", "/password") => match admin_or_pending(app, cookie) {
            Err(r) => r,
            Ok(()) => match body {
                Some(b) => change_password(app, b),
                None => Reply::json("{\"ok\":false,\"error\":\"corpo vuoto\"}".into()).status(400),
            },
        },
        ("GET", "/config") => match admin_block() {
            Some(r) => r,
            None => Reply::json(app.cfg.lock().unwrap().to_json_public()),
        },
        ("POST", "/config") => match admin_block() {
            Some(r) => r,
            None => match body {
                Some(b) => apply_config(app, b),
                None => Reply::json("{\"saved\":false,\"error\":\"corpo vuoto\"}".into()).status(400),
            },
        },
        ("GET", "/status") => match admin_block() {
            Some(r) => r,
            None => Reply::json(status_json(app)),
        },
        ("GET", "/jobs") => Reply::json(download::jobs_json(&app.jobs)),
        ("POST", "/download") => match body {
            None => Reply::json("{\"started\":false,\"error\":\"corpo vuoto\"}".into()).status(400),
            Some(b) => {
                let id = config::str_field(b, "id").unwrap_or_else(|| format!("job-{}", now()));
                match (config::str_field(b, "url"), config::str_field(b, "path")) {
                    (Some(url), Some(path)) => {
                        let dir = PathBuf::from(&app.cfg.lock().unwrap().download_dir);
                        match download::start(app.jobs.clone(), id, url, path, dir) {
                            Ok(started) => Reply::json(format!("{{\"started\":{started}}}")),
                            Err(e) => Reply::json(format!("{{\"started\":false,\"error\":\"{}\"}}", config::escape(&e))).status(400),
                        }
                    }
                    _ => Reply::json("{\"started\":false,\"error\":\"servono url e path\"}".into()).status(400),
                }
            }
        },
        ("POST", "/feed") | ("POST", "/feed.xml") | ("POST", "/feed.rss") => match body {
            None => Reply::json("{\"saved\":false,\"error\":\"corpo vuoto\"}".into()).status(400),
            Some(b) => match save_feed(app, b) {
                Ok((bytes, path)) => Reply::json(format!(
                    "{{\"saved\":true,\"bytes\":{bytes},\"path\":\"{}\"}}",
                    config::escape(&path)
                )),
                Err(e) => Reply::json(format!("{{\"saved\":false,\"error\":\"{}\"}}", config::escape(&e))).status(400),
            },
        },
        ("GET", "/feed.xml") | ("GET", "/feed.rss") => match fs::read_to_string(app.feed_path()) {
            Ok(b) => Reply {
                status: 200,
                ctype: "application/rss+xml; charset=utf-8",
                body: b,
                cookies: Vec::new(),
            },
            Err(e) => Reply::text(
                503,
                format!(
                    "feed non disponibile: {e}\npercorso atteso: {}\napri l'estensione e premi \"Invia feed\".\n",
                    app.feed_path().display()
                ),
            ),
        },
        _ => Reply::text(
            404,
            "rotte: GET / (configurazione) · POST /login · POST /password · POST /feed · POST /download · GET /jobs · GET /feed.xml · GET /status · GET /health\n"
                .to_string(),
        ),
    }
}

/// La modifica della password richiede una sessione, ma è ammessa anche prima
/// del cambio obbligatorio (altrimenti non se ne uscirebbe più).
fn admin_or_pending(app: &App, cookie: Option<&str>) -> Result<(), Reply> {
    if authed(app, cookie) {
        Ok(())
    } else {
        Err(Reply::json("{\"error\":\"serve il login\"}".into()).status(401))
    }
}

fn open_url(url: &str) {
    #[cfg(target_os = "linux")]
    {
        if std::process::Command::new("xdg-open").arg(url).spawn().is_err() {
            let _ = std::process::Command::new("gio").arg("open").arg(url).spawn();
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header valido")
}

// --- main ------------------------------------------------------------------

fn main() {
    let args = match parse_args(env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("errore: {e}");
            eprintln!("usa --help per l'uso");
            process::exit(2);
        }
    };

    let dir = args.data_dir.unwrap_or_else(default_data_dir);
    let headless = args.headless;
    let mut cfg = config::Config::load(&dir);
    if let Some(bind) = args.bind.clone() {
        cfg.apply(&format!("{{\"bind\":\"{}\"}}", config::escape(&bind)));
        let _ = cfg.save(&dir);
    }
    let app = Arc::new(App::new(dir.clone(), cfg));

    #[cfg(target_os = "linux")]
    if !args.headless {
        if let Some(handle) = tray::spawn(app.tray_snap.clone()) {
            let _ = app.tray.set(handle);
        }
    }

    println!(
        "anisat-feed {VERSION} — http://{}/ (configurazione)\nfeed: {}\nrepo: {REPO}",
        app.bind(),
        app.feed_path().display()
    );

    spawn_checks(app.clone());

    // ciclo di ascolto: se cambia il bind dalla configurazione, si riapre il server
    loop {
        let bind = app.bind();
        let server = match Server::http(&bind) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                eprintln!("impossibile ascoltare su {bind}: {e}");
                if headless {
                    process::exit(1);
                }
                // probabilmente un'altra istanza è già attiva: apro la sua pagina
                open_url(&format!("http://{bind}/"));
                process::exit(0);
            }
        };
        sync_tray(&app);

        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let wants_body = method == Method::Post;
            let body = if wants_body {
                let mut buf = String::new();
                let _ = request.as_reader().read_to_string(&mut buf);
                Some(buf)
            } else {
                None
            };

            let cookie = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Cookie"))
                .map(|h| h.value.as_str().to_string());
            let reply = handle(&app, method.as_str(), request.url(), body.as_deref(), cookie.as_deref());
            let mut response = Response::from_string(reply.body)
                .with_status_code(StatusCode(reply.status))
                .with_header(header("Content-Type", reply.ctype))
                .with_header(header("Cache-Control", "no-store"))
                .with_header(header("Access-Control-Allow-Origin", "*"))
                .with_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
                .with_header(header("Access-Control-Allow-Headers", "content-type"));
            for c in reply.cookies {
                response.add_header(header("Set-Cookie", &c));
            }
            let _ = request.respond(response);

            if app.restart.swap(false, Ordering::SeqCst) {
                server.unblock();
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str =
        "<?xml version=\"1.0\"?><rss><channel><title>Originale</title><item><title>A</title></item></channel></rss>";

    fn test_app(name: &str) -> (Arc<App>, PathBuf) {
        let dir = env::temp_dir().join(format!("anisat-feed-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        let app = Arc::new(App::new(dir.clone(), config::Config::default()));
        (app, dir)
    }

    /// App con password già cambiata e sessione valida: come dopo il primo accesso.
    fn logged(app: &Arc<App>) -> String {
        app.cfg.lock().unwrap().password = auth::hash_password("password lunga");
        let token = app.sessions.create();
        format!("anisat_sid={token}")
    }

    #[test]
    fn configurazione_richiede_login() {
        let (app, dir) = test_app("auth");
        let r = handle(&app, "GET", "/config", None, None);
        assert_eq!(r.status, 401);
        assert!(!r.body.contains("download_dir"));

        // senza password cambiata, anche con sessione la configurazione resta bloccata
        let token = app.sessions.create();
        let cookie = format!("anisat_sid={token}");
        let r = handle(&app, "GET", "/config", None, Some(&cookie));
        assert_eq!(r.status, 403);
        assert!(r.body.contains("must_change"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn login_password_iniziale_e_cambio_obbligatorio() {
        let (app, dir) = test_app("login");

        let r = handle(&app, "POST", "/login", Some("{\"password\":\"sbagliata\"}"), None);
        assert_eq!(r.status, 401);

        let r = handle(&app, "POST", "/login", Some("{\"password\":\"123456\"}"), None);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"must_change\":true"));
        let cookie = r.cookies.join("; ");
        assert!(cookie.contains("HttpOnly"));

        // cambio password con la sessione appena creata
        let r = handle(
            &app,
            "POST",
            "/password",
            Some("{\"current\":\"123456\",\"new\":\"una password lunga\"}"),
            Some(&cookie),
        );
        assert_eq!(r.status, 200);
        assert!(!app.cfg.lock().unwrap().password.is_empty(), "hash salvato");

        // ora la configurazione è accessibile, e il login usa la nuova password
        let r = handle(&app, "GET", "/config", None, Some(&cookie));
        assert_eq!(r.status, 200);
        let r = handle(&app, "POST", "/login", Some("{\"password\":\"123456\"}"), None);
        assert_eq!(r.status, 401, "la password iniziale non vale più");
        let r = handle(&app, "POST", "/login", Some("{\"password\":\"una password lunga\"}"), None);
        assert_eq!(r.status, 200);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rifiuta_password_debole() {
        let (app, dir) = test_app("debole");
        let cookie = logged(&app);
        let r = handle(&app, "POST", "/password", Some("{\"current\":\"password lunga\",\"new\":\"123\"}"), Some(&cookie));
        assert_eq!(r.status, 400);
        let r = handle(&app, "POST", "/password", Some("{\"current\":\"password lunga\",\"new\":\"12345678\"}"), Some(&cookie));
        assert_eq!(r.status, 400);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn post_feed_salva_riscrive_il_titolo_e_serve() {
        let (app, dir) = test_app("post");
        let r = handle(&app, "POST", "/feed", Some(SAMPLE), None);
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"saved\":true"));

        let r = handle(&app, "GET", "/feed.xml", None, None);
        assert_eq!(r.status, 200);
        assert_eq!(r.ctype, "application/rss+xml; charset=utf-8");
        assert!(r.body.contains("<title>AniSat Downloader - preferiti</title>"));
        assert!(!r.body.contains("Originale"));

        let cookie = logged(&app);
        let r = handle(&app, "GET", "/status", None, Some(&cookie));
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"items\":1"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn post_rifiuta_corpi_non_rss() {
        let (app, dir) = test_app("bad");
        let r = handle(&app, "POST", "/feed", Some("<html>nope</html>"), None);
        assert_eq!(r.status, 400);
        assert!(r.body.contains("\"saved\":false"));
        assert!(!dir.join(FEED_NAME).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pagina_e_config_api() {
        let (app, dir) = test_app("ui");
        let r = handle(&app, "GET", "/", None, None);
        assert_eq!(r.status, 200);
        assert!(r.ctype.starts_with("text/html"));
        assert!(r.body.contains("Nome del feed"));

        let cookie = logged(&app);
        let r = handle(&app, "POST", "/config", Some("{\"name\":\"Mio feed\"}"), Some(&cookie));
        assert_eq!(r.status, 200);
        assert!(r.body.contains("\"saved\":true"));

        let r = handle(&app, "GET", "/config", None, Some(&cookie));
        assert!(r.body.contains("Mio feed"));
        assert!(!r.body.contains("pbkdf2"), "l'hash non esce dalla API");
        assert!(dir.join("config.json").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cambio_bind_chiede_riavvio() {
        let (app, dir) = test_app("rebind");
        let cookie = logged(&app);
        let r = handle(&app, "POST", "/config", Some("{\"bind\":\"127.0.0.1:9911\"}"), Some(&cookie));
        assert!(r.body.contains("\"restarted\":true"));
        assert!(app.restart.load(Ordering::SeqCst));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn feed_assente_e_health_e_404() {
        let (app, dir) = test_app("assente");
        assert_eq!(handle(&app, "GET", "/feed.xml", None, None).status, 503);
        assert_eq!(handle(&app, "GET", "/health", None, None).status, 200);
        assert_eq!(handle(&app, "GET", "/nope", None, None).status, 404);
        assert_eq!(handle(&app, "OPTIONS", "/feed", None, None).status, 204);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn argomenti() {
        let a = parse_args(["--headless".to_string(), "--data-dir".to_string(), "/tmp/x".to_string()]).unwrap();
        assert!(a.headless);
        assert_eq!(a.data_dir, Some(PathBuf::from("/tmp/x")));
        assert!(parse_args(["--boh".to_string()]).is_err());
        assert!(parse_args(["--bind".to_string()]).is_err());
    }
}
