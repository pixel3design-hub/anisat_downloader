// anisat-feed — riceve il feed dall'estensione AniSat Downloader, lo salva in
// ~/.anisatrss/feed.rss e lo serve su HTTP.
//
//   POST /feed       corpo = XML del feed (text/plain)  → scrive il file
//   GET  /feed.xml   (alias /feed.rss, /)               → serve il file
//   GET  /status     JSON con percorso, byte, ultima modifica, numero di item
//   GET  /health     "ok"
//
// Il file è letto a ogni richiesta: nessun watcher, nessun reload da gestire.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::time::UNIX_EPOCH;

use tiny_http::{Header, Method, Response, Server, StatusCode};

const BIND_DEFAULT: &str = "127.0.0.1:8787";
const FEED_NAME: &str = "feed.rss";

// Riferimenti di sviluppo (da Cargo.toml, che a sua volta li prende dal repo GitHub)
const REPO: &str = env!("CARGO_PKG_REPOSITORY");
const AUTHOR: &str = env!("CARGO_PKG_AUTHORS");
const LICENSE: &str = env!("CARGO_PKG_LICENSE");

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn default_data_dir() -> PathBuf {
    home_dir().join(".anisatrss")
}

struct Args {
    data_dir: PathBuf,
    bind: String,
}

fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<Args, String> {
    let mut args = args.into_iter();
    let mut parsed = Args {
        data_dir: default_data_dir(),
        bind: BIND_DEFAULT.to_string(),
    };
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data-dir" => parsed.data_dir = PathBuf::from(args.next().ok_or("--data-dir richiede un percorso")?),
            "--bind" => parsed.bind = args.next().ok_or("--bind richiede host:porta")?,
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            "-V" | "--version" => {
                println!("anisat-feed {} ({})", env!("CARGO_PKG_VERSION"), REPO);
                process::exit(0);
            }
            other => return Err(format!("argomento sconosciuto: {other}")),
        }
    }
    Ok(parsed)
}

fn print_help() {
    println!(
        "anisat-feed {}\n\n\
         Riceve il feed RSS dall'estensione AniSat Downloader e lo serve su HTTP.\n\n\
         USO:\n    anisat-feed [--data-dir <cartella>] [--bind <host:porta>]\n\n\
         OPZIONI:\n    \
         --data-dir <cartella>  dove salvare feed.rss (default: {})\n    \
         --bind <indirizzo>     indirizzo di ascolto (default: {})\n    \
         -h, --help             questo aiuto\n    \
         -V, --version          versione\n\n\
         ROTTE:\n    \
         POST /feed             salva il feed inviato dall'estensione\n    \
         GET  /feed.xml         feed (alias: /feed.rss, /)\n    \
         GET  /status           JSON: percorso, byte, ultima modifica, item\n    \
         GET  /health           \"ok\"\n\n\
         REPOSITORIO:\n    {}\n    segnalazioni: {}/issues\n\n\
         AUTORE:\n    {}\n\n\
         LICENZA:\n    {} — testo completo in COPYING\n",
        env!("CARGO_PKG_VERSION"),
        default_data_dir().join(FEED_NAME).display(),
        BIND_DEFAULT,
        REPO,
        REPO,
        AUTHOR,
        LICENSE,
    );
}

fn epoch_secs(t: std::time::SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn status_json(feed: &Path) -> (u16, &'static str, String) {
    match fs::metadata(feed) {
        Ok(m) => {
            let items = fs::read_to_string(feed)
                .map(|b| b.matches("<item>").count())
                .unwrap_or(0);
            let body = format!(
                "{{\"path\":\"{}\",\"bytes\":{},\"updated_at\":{},\"items\":{}}}\n",
                json_escape(&feed.display().to_string()),
                m.len(),
                m.modified().map(epoch_secs).unwrap_or(0),
                items
            );
            (200, "application/json; charset=utf-8", body)
        }
        Err(_) => (
            200,
            "application/json; charset=utf-8",
            format!("{{\"path\":\"{}\",\"bytes\":0,\"updated_at\":0,\"items\":0}}\n", json_escape(&feed.display().to_string())),
        ),
    }
}

fn save_feed(dir: &Path, body: &str) -> Result<usize, String> {
    let text = body.trim_start();
    if !(text.starts_with("<?xml") || text.starts_with("<rss")) || !text.contains("<rss") {
        return Err("il corpo non sembra un feed RSS".to_string());
    }
    fs::create_dir_all(dir).map_err(|e| format!("impossibile creare {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".{FEED_NAME}.tmp"));
    fs::write(&tmp, body).map_err(|e| format!("scrittura fallita: {e}"))?;
    fs::rename(&tmp, dir.join(FEED_NAME)).map_err(|e| format!("rename fallito: {e}"))?;
    Ok(body.len())
}

// (status, content-type, body)
fn handle(method: &str, url: &str, dir: &Path, body: Option<&str>) -> (u16, &'static str, String) {
    let path = url.split('?').next().unwrap_or("/");
    let feed = dir.join(FEED_NAME);
    let json = "application/json; charset=utf-8";

    match (method, path) {
        ("OPTIONS", _) => (204, "text/plain; charset=utf-8", String::new()),
        ("GET", "/health") => (200, "text/plain; charset=utf-8", "ok\n".to_string()),
        ("GET", "/status") => status_json(&feed),
        ("GET", "/feed.xml") | ("GET", "/feed.rss") | ("GET", "/") => match fs::read_to_string(&feed) {
            Ok(b) => (200, "application/rss+xml; charset=utf-8", b),
            Err(e) => (
                503,
                "text/plain; charset=utf-8",
                format!(
                    "feed non disponibile: {e}\npercorso atteso: {}\napri l'estensione e premi \"Invia feed\".\n",
                    feed.display()
                ),
            ),
        },
        ("POST", "/feed") | ("POST", "/feed.xml") | ("POST", "/feed.rss") => match body {
            None => (400, json, "{\"saved\":false,\"error\":\"corpo vuoto\"}\n".to_string()),
            Some(b) => match save_feed(dir, b) {
                Ok(bytes) => (
                    200,
                    json,
                    format!(
                        "{{\"saved\":true,\"bytes\":{bytes},\"path\":\"{}\"}}\n",
                        json_escape(&feed.display().to_string())
                    ),
                ),
                Err(e) => (400, json, format!("{{\"saved\":false,\"error\":\"{}\"}}\n", json_escape(&e))),
            },
        },
        _ => (
            404,
            "text/plain; charset=utf-8",
            "rotte: POST /feed · GET /feed.xml · GET /status · GET /health\n".to_string(),
        ),
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header valido")
}

fn main() {
    let args = match parse_args(env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("errore: {e}");
            eprintln!("usa --help per l'uso");
            process::exit(2);
        }
    };

    let server = match Server::http(&args.bind) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("impossibile ascoltare su {}: {e}", args.bind);
            process::exit(1);
        }
    };

    let feed = args.data_dir.join(FEED_NAME);
    println!(
        "anisat-feed {} — http://{}/feed.xml\nfile: {}\nrepo: {}",
        env!("CARGO_PKG_VERSION"),
        args.bind,
        feed.display(),
        REPO
    );

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let is_write = method == Method::Post;
        let body = if is_write {
            let mut buf = String::new();
            let _ = request.as_reader().read_to_string(&mut buf);
            Some(buf)
        } else {
            None
        };

        let (status, ctype, payload) = handle(method.as_str(), request.url(), &args.data_dir, body.as_deref());
        let response = Response::from_string(payload)
            .with_status_code(StatusCode(status))
            .with_header(header("Content-Type", ctype))
            .with_header(header("Cache-Control", "no-store"))
            .with_header(header("Access-Control-Allow-Origin", "*"))
            .with_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
            .with_header(header("Access-Control-Allow-Headers", "content-type"));
        let _ = request.respond(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("anisat-feed-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    const SAMPLE: &str = "<?xml version=\"1.0\"?><rss><channel><item><title>A</title></item></channel></rss>";

    #[test]
    fn post_salva_e_get_serve() {
        let dir = temp_dir("post");
        let (status, _, body) = handle("POST", "/feed", &dir, Some(SAMPLE));
        assert_eq!(status, 200);
        assert!(body.contains("\"saved\":true"));

        let (status, ctype, body) = handle("GET", "/feed.xml", &dir, None);
        assert_eq!(status, 200);
        assert_eq!(ctype, "application/rss+xml; charset=utf-8");
        assert!(body.contains("<rss>"));

        let (_, _, status_json) = handle("GET", "/status", &dir, None);
        assert!(status_json.contains("\"items\":1"));
        assert!(status_json.contains(".anisatrss") || status_json.contains("feed.rss"));
    }

    #[test]
    fn post_rifiuta_corpi_non_rss() {
        let dir = temp_dir("bad");
        let (status, _, body) = handle("POST", "/feed", &dir, Some("<html>nope</html>"));
        assert_eq!(status, 400);
        assert!(body.contains("\"saved\":false"));
        assert!(!dir.join(FEED_NAME).exists());
    }

    #[test]
    fn feed_assente_e_503_non_panico() {
        let dir = temp_dir("assente");
        let (status, _, body) = handle("GET", "/feed.xml", &dir, None);
        assert_eq!(status, 503);
        assert!(body.contains("feed non disponibile"));
        let (status, _, body) = handle("GET", "/status", &dir, None);
        assert_eq!(status, 200);
        assert!(body.contains("\"bytes\":0"));
    }

    #[test]
    fn health_e_404() {
        let dir = default_data_dir();
        assert_eq!(handle("GET", "/health", &dir, None).0, 200);
        assert_eq!(handle("GET", "/nope", &dir, None).0, 404);
        assert_eq!(handle("OPTIONS", "/feed", &dir, None).0, 204);
    }

    #[test]
    fn argomenti() {
        let a = parse_args(["--data-dir".to_string(), "/tmp/x".to_string()]).unwrap();
        assert_eq!(a.data_dir, PathBuf::from("/tmp/x"));
        assert_eq!(a.bind, BIND_DEFAULT);
        assert!(parse_args(["--boh".to_string()]).is_err());
        assert!(parse_args(["--data-dir".to_string()]).is_err());
    }
}
