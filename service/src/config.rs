// Configurazione persistente in <data-dir>/config.json.
// JSON minimale scritto/letto a mano: niente serde per 4 campi.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Config {
    pub name: String,
    pub bind: String,
    pub check_min: u32,
    pub version_check: bool,
    pub download_dir: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            name: "AniSat Downloader - preferiti".to_string(),
            bind: crate::BIND_DEFAULT.to_string(),
            check_min: 30,
            version_check: true,
            download_dir: crate::home_dir().join("Downloads").join("AniSatDownloader").display().to_string(),
        }
    }
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => break,
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\t', "\\t")
}

// valore stringa di un campo JSON flat: "chiave":"valore"
pub fn str_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(unescape(&out)),
            '\\' => {
                out.push('\\');
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            }
            other => out.push(other),
        }
    }
    None
}

fn num_field(json: &str, key: &str) -> Option<u32> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start().strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn bool_field(json: &str, key: &str) -> Option<bool> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start().strip_prefix(':')?.trim_start();
    if rest.starts_with("true") {
        Some(true)
    } else if rest.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

/// "~/Downloads/x" -> "/home/utente/Downloads/x"
pub fn expand_home(s: &str) -> String {
    match s.strip_prefix("~/") {
        Some(rest) => crate::home_dir().join(rest).display().to_string(),
        None => s.to_string(),
    }
}

impl Config {
    pub fn load(dir: &Path) -> Config {
        let mut cfg = Config::default();
        if let Ok(text) = fs::read_to_string(config_path(dir)) {
            cfg.apply(&text);
        }
        cfg
    }

    /// Applica un JSON parziale (config su disco o patch dal browser).
    /// Restituisce true se cambia qualcosa.
    pub fn apply(&mut self, json: &str) -> bool {
        let mut changed = false;
        if let Some(v) = str_field(json, "name") {
            let v = v.trim().to_string();
            if !v.is_empty() && v != self.name {
                self.name = v;
                changed = true;
            }
        }
        if let Some(v) = str_field(json, "bind") {
            let v = v.trim().to_string();
            if v.contains(':') && v != self.bind {
                self.bind = v;
                changed = true;
            }
        }
        if let Some(v) = num_field(json, "check_min") {
            let v = v.clamp(5, 1440);
            if v != self.check_min {
                self.check_min = v;
                changed = true;
            }
        }
        if let Some(v) = str_field(json, "download_dir") {
            let v = expand_home(v.trim());
            if !v.is_empty() && v != self.download_dir {
                self.download_dir = v;
                changed = true;
            }
        }
        if let Some(v) = bool_field(json, "version_check") {
            if v != self.version_check {
                self.version_check = v;
                changed = true;
            }
        }
        changed
    }

    pub fn to_json(&self) -> String {
        format!(
            "{{\"name\":\"{}\",\"bind\":\"{}\",\"check_min\":{},\"version_check\":{},\"download_dir\":\"{}\"}}",
            escape(&self.name),
            escape(&self.bind),
            self.check_min,
            self.version_check,
            escape(&self.download_dir)
        )
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| format!("impossibile creare {}: {e}", dir.display()))?;
        let tmp = dir.join(".config.json.tmp");
        fs::write(&tmp, self.to_json()).map_err(|e| format!("scrittura config fallita: {e}"))?;
        fs::rename(&tmp, config_path(dir)).map_err(|e| format!("rename config fallito: {e}"))
    }
}

/// Il nome configurato sostituisce il <title> del canale nel feed ricevuto.
pub fn rewrite_title(xml: &str, name: &str) -> String {
    let Some(ch) = xml.find("<channel>") else {
        return xml.to_string();
    };
    let rest = &xml[ch..];
    let Some(t0) = rest.find("<title>") else {
        return xml.to_string();
    };
    let Some(t1) = rest[t0..].find("</title>") else {
        return xml.to_string();
    };
    let start = ch + t0 + "<title>".len();
    let end = ch + t0 + t1;
    format!("{}{}{}", &xml[..start], escape_xml(name), &xml[end..])
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// "v0.2.0" / "0.3" / "1.2.3-beta" -> (major, minor, patch)
pub fn parse_version(s: &str) -> (u32, u32, u32) {
    let s = s.trim().trim_start_matches('v');
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let mut it = core.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_roundtrip() {
        let mut c = Config::default();
        c.name = "Feed \"speciale\" & co".to_string();
        c.check_min = 45;
        c.version_check = false;
        let mut back = Config::default();
        assert!(back.apply(&c.to_json()));
        assert_eq!(back.name, c.name);
        assert_eq!(back.check_min, 45);
        assert!(!back.version_check);
        assert_eq!(back.bind, c.bind);
    }

    #[test]
    fn patch_parziale_e_clamp() {
        let mut c = Config::default();
        c.apply("{\"check_min\":1}");
        assert_eq!(c.check_min, 5, "minimo 5 minuti");
        c.apply("{\"bind\":\"nonvalido\"}");
        assert_eq!(c.bind, crate::BIND_DEFAULT, "bind rifiutato senza porta");
        c.apply("{\"bind\":\"0.0.0.0:9000\"}");
        assert_eq!(c.bind, "0.0.0.0:9000");
    }

    #[test]
    fn titolo_del_canale_sostituito() {
        let xml = "<?xml version=\"1.0\"?><rss><channel><title>Vecchio</title><item><title>Ep 1</title></item></channel></rss>";
        let out = rewrite_title(xml, "Nuovo & bello");
        assert!(out.contains("<title>Nuovo &amp; bello</title>"));
        assert!(out.contains("<title>Ep 1</title>"), "i titoli degli item non si toccano");
        assert!(!out.contains("Vecchio"));
    }

    #[test]
    fn versioni() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("v0.2.0", "0.2.0"));
        assert!(!is_newer("v0.1.9", "0.2.0"));
        assert_eq!(parse_version("v1.2.3-beta"), (1, 2, 3));
    }
}
