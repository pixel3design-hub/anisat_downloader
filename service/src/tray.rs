// Icona nella barra dei programmi (StatusNotifierItem via D-Bus, solo Linux).
// Niente GTK: ksni parla direttamente con il watcher di KDE/GNOME.

use std::sync::{Arc, Mutex, OnceLock};

use ksni::blocking::{Handle, TrayMethods};
use ksni::menu::StandardItem;

#[derive(Clone, Default)]
pub struct Snapshot {
    pub name: String,
    pub bind: String,
    pub items: usize,
    pub latest: Option<String>,
    pub check_error: Option<String>,
}

pub struct AniTray {
    pub snap: Arc<Mutex<Snapshot>>,
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn page_url(bind: &str) -> String {
    let host = bind.replace("0.0.0.0", "127.0.0.1").replace("[::]", "127.0.0.1");
    format!("http://{host}/")
}

impl ksni::Tray for AniTray {
    fn id(&self) -> String {
        "anisat-feed".into()
    }

    fn title(&self) -> String {
        "AniSat Feed".into()
    }

    fn category(&self) -> ksni::Category {
        ksni::Category::ApplicationStatus
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        icons().to_vec()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        let s = self.snap.lock().unwrap().clone();
        let mut desc = format!("{} · {} item · v{}", s.name, s.items, VERSION);
        if let Some(l) = &s.latest {
            desc.push_str(&format!("\nAggiornamento disponibile: {l}"));
        }
        if let Some(e) = &s.check_error {
            desc.push_str(&format!("\nControllo versione: {e}"));
        }
        ksni::ToolTip {
            title: "AniSat Feed".into(),
            description: desc,
            icon_pixmap: icons().to_vec(),
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        let bind = self.snap.lock().unwrap().bind.clone();
        vec![
            StandardItem {
                label: "Apri configurazione".into(),
                activate: Box::new({ let b = bind.clone(); move |_| crate::open_url(&page_url(&b)) }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Apri il feed".into(),
                activate: Box::new({ let b = bind.clone(); move |_| crate::open_url(&format!("{}feed.xml", page_url(&b))) }),
                ..Default::default()
            }
            .into(),
            ksni::MenuItem::Separator,
            StandardItem {
                label: "Esci".into(),
                activate: Box::new(|_| std::process::exit(0)),
                ..Default::default()
            }
            .into(),
        ]
    }
}

/// Avvia il tray in un thread. Se non c'è un bus di sessione (server, ssh) restituisce None.
pub fn spawn(snap: Arc<Mutex<Snapshot>>) -> Option<Handle<AniTray>> {
    match (AniTray { snap }).spawn() {
        Ok(handle) => Some(handle),
        Err(e) => {
            eprintln!("tray non disponibile: {e}");
            None
        }
    }
}

// --- icona -----------------------------------------------------------------

static ICONS: OnceLock<Vec<ksni::Icon>> = OnceLock::new();

pub fn icons() -> &'static [ksni::Icon] {
    ICONS.get_or_init(decode_icons)
}

fn decode_icons() -> Vec<ksni::Icon> {
    let Some((w, h, rgba)) = decode_png(include_bytes!("../assets/icon.png")) else {
        return Vec::new();
    };
    [32i32, 64]
        .into_iter()
        .map(|size| ksni::Icon {
            width: size,
            height: size,
            data: to_argb(&rgba, w, h, size),
        })
        .collect()
}

fn decode_png(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;

    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()]
            .chunks(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        _ => return None,
    };
    Some((info.width, info.height, rgba))
}

// ksni vuole ARGB32 in ordine di byte di rete: [a, r, g, b]
fn to_argb(rgba: &[u8], w: u32, h: u32, size: i32) -> Vec<u8> {
    let size = size.max(1) as u32;
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let sx = x * w / size;
            let sy = y * h / size;
            let i = ((sy * w + sx) * 4) as usize;
            let (r, g, b, a) = if i + 3 < rgba.len() {
                (rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])
            } else {
                (0, 0, 0, 0)
            };
            out.extend_from_slice(&[a, r, g, b]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icona_decodificata_e_convertita() {
        let icons = icons();
        assert_eq!(icons.len(), 2);
        assert_eq!(icons[0].width, 32);
        assert_eq!(icons[0].data.len(), 32 * 32 * 4);
        assert!(icons[1].data.len() == 64 * 64 * 4);
    }
}
