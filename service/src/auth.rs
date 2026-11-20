// Autenticazione della pagina di amministrazione.
//
// La prima volta la password è 123456 e va cambiata: finché `Config::password`
// è vuota il server risponde 403 alle rotte di configurazione e la UI mostra solo
// il form di cambio password.
//
// Le password sono salvate come PBKDF2-HMAC-SHA256 (salt casuale, 120k iterazioni).
// Le sessioni stanno in memoria: un riavvio del servizio le invalida.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

pub const DEFAULT_PASSWORD: &str = "123456";
const ITERS: u32 = 120_000;
const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);
const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(30);

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

fn pbkdf2(password: &[u8], salt: &[u8], iters: u32, out_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(out_len);
    let mut block: u32 = 1;
    while out.len() < out_len {
        let mut seed = salt.to_vec();
        seed.extend_from_slice(&block.to_be_bytes());
        let mut u = hmac_sha256(password, &seed);
        let mut t = u;
        for _ in 1..iters {
            u = hmac_sha256(password, &u);
            for i in 0..32 {
                t[i] ^= u[i];
            }
        }
        out.extend_from_slice(&t);
        block += 1;
    }
    out.truncate(out_len);
    out
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()).collect()
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf;
        }
    }
    // senza /dev/urandom (Windows, sistemi esotici): tempo + pid, non ideale ma meglio di niente
    let seed = format!("{:?}-{}", SystemTime::now(), std::process::id());
    let mut out = Vec::with_capacity(n);
    let mut h = Sha256::digest(seed.as_bytes()).to_vec();
    while out.len() < n {
        out.extend_from_slice(&h);
        h = Sha256::digest(&h).to_vec();
    }
    out.truncate(n);
    out
}

/// "pbkdf2-sha256$120000$<salt>$<hash>"
pub fn hash_password(password: &str) -> String {
    let salt = random_bytes(16);
    let hash = pbkdf2(password.as_bytes(), &salt, ITERS, 32);
    format!("pbkdf2-sha256${ITERS}${}${}", to_hex(&salt), to_hex(&hash))
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn verify_password(stored: &str, password: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256" {
        return false;
    }
    let Ok(iters) = parts[1].parse::<u32>() else {
        return false;
    };
    let (Some(salt), Some(expected)) = (from_hex(parts[2]), from_hex(parts[3])) else {
        return false;
    };
    constant_eq(&pbkdf2(password.as_bytes(), &salt, iters, expected.len()), &expected)
}

pub fn check_default(password: &str) -> bool {
    constant_eq(password.as_bytes(), DEFAULT_PASSWORD.as_bytes())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Password debole: troppo corta o uguale a quella iniziale.
pub fn weak_password(p: &str) -> Option<&'static str> {
    if p.chars().count() < 8 {
        return Some("almeno 8 caratteri");
    }
    if p == DEFAULT_PASSWORD {
        return Some("diversa da quella iniziale");
    }
    if p.chars().all(|c| c.is_ascii_digit()) {
        return Some("non solo cifre");
    }
    None
}

#[derive(Default)]
pub struct Sessions {
    inner: Mutex<HashMap<String, u64>>,
    failures: Mutex<(u32, u64)>, // (conteggio, istante dello sblocco)
}

impl Sessions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self) -> String {
        let token = to_hex(&random_bytes(24));
        let mut map = self.inner.lock().unwrap();
        map.retain(|_, exp| *exp > now());
        map.insert(token.clone(), now() + SESSION_TTL.as_secs());
        token
    }

    pub fn valid(&self, token: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        match map.get(token) {
            Some(exp) if *exp > now() => true,
            Some(_) => {
                map.remove(token);
                false
            }
            None => false,
        }
    }

    pub fn drop(&self, token: &str) {
        self.inner.lock().unwrap().remove(token);
    }

    /// true se l'accesso è temporaneamente bloccato
    pub fn locked(&self) -> bool {
        let f = self.failures.lock().unwrap();
        f.1 > now()
    }

    pub fn register_failure(&self) {
        let mut f = self.failures.lock().unwrap();
        f.0 += 1;
        if f.0 >= MAX_FAILURES {
            f.1 = now() + LOCKOUT.as_secs();
            f.0 = 0;
        }
    }

    pub fn reset_failures(&self) {
        *self.failures.lock().unwrap() = (0, 0);
    }
}

/// Estrae il token di sessione dal cookie.
pub fn session_from_cookie(cookie_header: Option<&str>) -> Option<String> {
    let header = cookie_header?;
    for part in header.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("anisat_sid=") {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub fn session_cookie(token: &str) -> String {
    format!("anisat_sid={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}", SESSION_TTL.as_secs())
}

pub fn clear_cookie() -> String {
    "anisat_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_e_verifica() {
        let stored = hash_password("una password lunga");
        assert!(stored.starts_with("pbkdf2-sha256$"));
        assert!(verify_password(&stored, "una password lunga"));
        assert!(!verify_password(&stored, "una password lunga "));
        assert!(!verify_password("spazzatura", "x"));
    }

    #[test]
    fn password_iniziale() {
        assert!(check_default("123456"));
        assert!(!check_default("1234567"));
    }

    #[test]
    fn regole_password() {
        assert!(weak_password("12345678").is_none() == false, "solo cifre rifiutata");
        assert!(weak_password("123456").is_some());
        assert!(weak_password("corta").is_some());
        assert!(weak_password("banana blu").is_none());
    }

    #[test]
    fn sessioni() {
        let s = Sessions::new();
        let t = s.create();
        assert!(s.valid(&t));
        s.drop(&t);
        assert!(!s.valid(&t));
        assert!(!s.valid("altro"));
    }

    #[test]
    fn cookie() {
        assert_eq!(session_from_cookie(Some("a=1; anisat_sid=abc; b=2")).as_deref(), Some("abc"));
        assert_eq!(session_from_cookie(Some("a=1")), None);
        assert!(session_cookie("abc").contains("HttpOnly"));
    }

    #[test]
    fn blocco_dopo_troppi_tentativi() {
        let s = Sessions::new();
        for _ in 0..MAX_FAILURES {
            s.register_failure();
        }
        assert!(s.locked());
        s.reset_failures();
        assert!(!s.locked());
    }
}
