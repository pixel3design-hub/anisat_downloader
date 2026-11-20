// Download degli episodi eseguiti dal servizio: la cartella si configura una volta
// nella pagina web, così il browser non chiede mai il percorso (l'API downloads
// mostra il dialogo a ogni file se l'utente ha attivato "chiedi dove salvare").

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::config;

#[derive(Clone, Debug)]
pub struct Job {
    pub state: String, // downloading | done | error
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

pub type Jobs = Arc<Mutex<HashMap<String, Job>>>;

pub fn new_jobs() -> Jobs {
    Arc::new(Mutex::new(HashMap::new()))
}

fn update(jobs: &Jobs, id: &str, f: impl FnOnce(&mut Job)) {
    if let Some(job) = jobs.lock().unwrap().get_mut(id) {
        f(job);
    }
}

pub fn jobs_json(jobs: &Jobs) -> String {
    let map = jobs.lock().unwrap();
    let items: Vec<String> = map
        .iter()
        .map(|(id, j)| {
            format!(
                "{{\"id\":\"{}\",\"state\":\"{}\",\"done\":{},\"total\":{},\"error\":{}}}",
                config::escape(id),
                j.state,
                j.done,
                j.total,
                j.error.clone().map(|e| format!("\"{}\"", config::escape(&e))).unwrap_or_else(|| "null".into())
            )
        })
        .collect();
    format!("{{\"jobs\":[{}]}}", items.join(","))
}

/// Niente percorsi assoluti o risalite: il file resta dentro la cartella configurata.
fn safe_rel(path: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.split('/') {
        let p = part.trim();
        if p.is_empty() || p == "." || p == ".." || p.contains('\\') {
            continue;
        }
        out.push(p);
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn start(jobs: Jobs, id: String, url: String, rel_path: String, dir: PathBuf) -> Result<bool, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("url non http".to_string());
    }
    let Some(rel) = safe_rel(&rel_path) else {
        return Err("percorso non valido".to_string());
    };

    {
        let mut map = jobs.lock().unwrap();
        if map.get(&id).map(|j| j.state == "downloading").unwrap_or(false) {
            return Ok(false);
        }
        // tiene il registro piccolo: via i job finiti quando diventano troppi
        if map.len() > 300 {
            map.retain(|_, j| j.state == "downloading");
        }
        map.insert(id.clone(), Job { state: "downloading".into(), done: 0, total: 0, error: None });
    }

    let worker = jobs.clone();
    std::thread::spawn(move || {
        let result = fetch_to_file(&worker, &id, &url, &dir, &rel);
        update(&worker, &id, |j| match result {
            Ok(()) => {
                j.state = "done".into();
                j.error = None;
            }
            Err(e) => {
                j.state = "error".into();
                j.error = Some(e);
            }
        });
    });

    Ok(true)
}

fn fetch_to_file(jobs: &Jobs, id: &str, url: &str, dir: &Path, rel: &Path) -> Result<(), String> {
    let target = dir.join(rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cartella non creabile: {e}"))?;
    }

    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(None)
            .build(),
    );
    let mut resp = agent
        .get(url)
        .header("User-Agent", concat!("anisat-feed/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| format!("richiesta fallita: {e}"))?;

    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    update(jobs, id, |j| j.total = total);

    let mut file = File::create(&target).map_err(|e| format!("scrittura impossibile: {e}"))?;
    let mut reader = resp.body_mut().as_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    let mut last = 0u64;

    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("lettura interrotta: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("scrittura interrotta: {e}"))?;
        done += n as u64;
        if done - last > 2 * 1024 * 1024 {
            last = done;
            update(jobs, id, |j| j.done = done);
        }
    }
    file.flush().map_err(|e| format!("flush fallito: {e}"))?;
    update(jobs, id, |j| j.done = done);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percorsi_relativi_sicuri() {
        assert_eq!(safe_rel("Serie X/Ep 01.mp4").unwrap(), PathBuf::from("Serie X/Ep 01.mp4"));
        assert_eq!(safe_rel("/etc/passwd").unwrap(), PathBuf::from("etc/passwd"));
        assert_eq!(safe_rel("../../segreto").unwrap(), PathBuf::from("segreto"));
        assert_eq!(safe_rel("   "), None);
        assert_eq!(safe_rel("/"), None);
    }

    #[test]
    fn rifiuta_url_non_http() {
        let jobs = new_jobs();
        let err = start(jobs, "a".into(), "file:///etc/passwd".into(), "x.mp4".into(), PathBuf::from("/tmp"));
        assert!(err.is_err());
    }

    #[test]
    fn job_duplicato_non_parte_due_volte() {
        let jobs = new_jobs();
        jobs.lock().unwrap().insert(
            "dup".into(),
            Job { state: "downloading".into(), done: 0, total: 0, error: None },
        );
        let started = start(jobs.clone(), "dup".into(), "http://127.0.0.1:1/x".into(), "x.mp4".into(), PathBuf::from("/tmp")).unwrap();
        assert!(!started);
        assert!(jobs_json(&jobs).contains("\"downloading\""));
    }
}
