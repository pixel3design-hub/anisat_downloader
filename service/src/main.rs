// anisat-feed — serve su HTTP il feed.xml scritto dall'estensione AniSat Downloader.
// Legge il file a ogni richiesta: nessun watcher, nessun reload da gestire.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

use tiny_http::{Header, Response, Server, StatusCode};

const BIND_DEFAULT: &str = "127.0.0.1:8787";

// Riferimenti di sviluppo (da Cargo.toml, che a sua volta li prende dal repo GitHub)
const REPO: &str = env!("CARGO_PKG_REPOSITORY");
const AUTHOR: &str = env!("CARGO_PKG_AUTHORS");
const LICENSE: &str = env!("CARGO_PKG_LICENSE");

fn default_feed_path() -> PathBuf {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Downloads").join("AniSatDownloader").join("feed.xml")
}

struct Args {
    feed: PathBuf,
    bind: String,
}

fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<Args, String> {
    let mut args = args.into_iter();
    let mut parsed = Args {
        feed: default_feed_path(),
        bind: BIND_DEFAULT.to_string(),
    };
    while let Some(a) = args.next() {
        match a.as_str() {
            "--feed" => parsed.feed = PathBuf::from(args.next().ok_or("--feed richiede un percorso")?),
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
         Serve il feed RSS generato dall'estensione AniSat Downloader.\n\n\
         USO:\n    anisat-feed [--feed <percorso>] [--bind <host:porta>]\n\n\
         OPZIONI:\n    \
         --feed <percorso>   file feed.xml (default: {})\n    \
         --bind <indirizzo>  indirizzo di ascolto (default: {})\n    \
         -h, --help          questo aiuto\n    \
         -V, --version       versione\n\n\
         REPOSITORIO:\n    {}\n    segnalazioni: {}/issues\n\n\
         AUTORE:\n    {}\n\n\
         LICENZA:\n    {} — testo completo in COPYING\n",
        env!("CARGO_PKG_VERSION"),
        default_feed_path().display(),
        BIND_DEFAULT,
        REPO,
        REPO,
        AUTHOR,
        LICENSE,
    );
}

// (status, content-type, body)
fn route(url: &str, feed: &Path) -> (u16, &'static str, String) {
    let path = url.split('?').next().unwrap_or("/");
    match path {
        "/health" => (200, "text/plain; charset=utf-8", "ok\n".to_string()),
        "/feed.xml" => match fs::read_to_string(feed) {
            Ok(body) => (200, "application/rss+xml; charset=utf-8", body),
            Err(e) => (
                503,
                "text/plain; charset=utf-8",
                format!(
                    "feed non disponibile: {e}\npercorso atteso: {}\n\
                     apri l'estensione e premi \"Riscrivi feed\".\n",
                    feed.display()
                ),
            ),
        },
        _ => (
            404,
            "text/plain; charset=utf-8",
            "rotte: /feed.xml, /health\n".to_string(),
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

    println!(
        "anisat-feed {} — http://{}/feed.xml\nfile: {}\nrepo: {}",
        env!("CARGO_PKG_VERSION"),
        args.bind,
        args.feed.display(),
        REPO
    );

    for request in server.incoming_requests() {
        let (status, ctype, body) = route(request.url(), &args.feed);
        let response = Response::from_string(body)
            .with_status_code(StatusCode(status))
            .with_header(header("Content-Type", ctype))
            .with_header(header("Cache-Control", "no-store"))
            .with_header(header("Access-Control-Allow-Origin", "*"));
        let _ = request.respond(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_feed(name: &str, content: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("anisat-feed-test-{name}.xml"));
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn serve_il_feed_esistente() {
        let path = temp_feed("ok", "<?xml version=\"1.0\"?><rss><channel/></rss>");
        let (status, ctype, body) = route("/feed.xml?x=1", &path);
        assert_eq!(status, 200);
        assert_eq!(ctype, "application/rss+xml; charset=utf-8");
        assert!(body.contains("<rss>"));
    }

    #[test]
    fn feed_mancante_e_503_non_panico() {
        let path = env::temp_dir().join("anisat-feed-test-assente.xml");
        let _ = fs::remove_file(&path);
        let (status, _, body) = route("/feed.xml", &path);
        assert_eq!(status, 503);
        assert!(body.contains("feed non disponibile"));
    }

    #[test]
    fn health_e_404() {
        let path = default_feed_path();
        assert_eq!(route("/health", &path).0, 200);
        assert_eq!(route("/nope", &path).0, 404);
    }

    #[test]
    fn argomenti() {
        let a = parse_args(["--feed".to_string(), "/tmp/x.xml".to_string()]).unwrap();
        assert_eq!(a.feed, PathBuf::from("/tmp/x.xml"));
        assert_eq!(a.bind, BIND_DEFAULT);
        assert!(parse_args(["--boh".to_string()]).is_err());
        assert!(parse_args(["--feed".to_string()]).is_err());
    }
}
