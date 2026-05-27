use std::sync::OnceLock;

pub struct Theme {
    /// Row selection background, e.g. "48;5;236"
    pub sel_bg: &'static str,
    /// Metadata, paths, decorative separators
    pub text_dim: &'static str,
    /// Tertiary text ("… N more lines", non-backed meta)
    pub text_faint: &'static str,
    /// Normal readable text
    pub text_primary: &'static str,
    /// Tool input secondary lines
    pub text_secondary: &'static str,
    /// Recent / active indicator (green)
    pub fresh: &'static str,
    /// Moderate age / soft warning (orange)
    pub moderate: &'static str,
    /// Inactive branch / stale state (gray)
    pub stale: &'static str,
    /// Errors, detached HEAD (red)
    pub error: &'static str,
    /// Bold section headers (gold/amber)
    pub header: &'static str,
    /// Main branch accent (gold/amber, non-bold)
    pub accent: &'static str,
    /// Inline label color: branch tags in show, tool names (yellow)
    pub label: &'static str,
    /// Linked worktrees, backed-up branches (blue)
    pub link: &'static str,
    /// Backed-up session name column
    pub backed_name: &'static str,
    /// Backed-up session metadata column
    pub backed_meta: &'static str,
    /// Non-backed session name column
    pub unbacked_name: &'static str,
    /// Non-backed session metadata column
    pub unbacked_meta: &'static str,
    /// Non-error tool result (purple)
    pub tool_ok: &'static str,
    /// Bold tidy panel warning title
    pub tidy_warn: &'static str,
    /// ANSI 256 code for inactive/unbacked agents
    pub stale_agent: u8,
    // ── Markdown skin (AnsiValue indices) ────────────────────────────────────
    pub md_code: u8,
    pub md_text: u8,
    pub md_h1: u8,
    pub md_h2: u8,
    pub md_h3: u8,
    pub md_bold: u8,
    pub md_italic: u8,
}

static THEME: OnceLock<Theme> = OnceLock::new();

pub fn get() -> &'static Theme {
    THEME.get_or_init(detect)
}

fn detect() -> Theme {
    // Explicit override wins
    if let Ok(v) = std::env::var("GOSSAMER_THEME") {
        match v.to_lowercase().as_str() {
            "light" => return light(),
            "dark"  => return dark(),
            _ => {}
        }
    }

    // Query the terminal directly for its background colour (OSC 11). Works in
    // iTerm2, Terminal.app, Alacritty, Kitty, WezTerm, foot, modern xterm, etc.
    if let Some(luma) = query_terminal_luma() {
        return if luma > 0.5 { light() } else { dark() };
    }

    // COLORFGBG="fg;bg" — set by rxvt and a few configs; background index 7
    // (white) or 15 (bright white) means a light terminal.
    if let Ok(v) = std::env::var("COLORFGBG") {
        if let Some(bg) = v.rsplit(';').next().and_then(|s| s.trim().parse::<u8>().ok()) {
            if bg == 7 || bg == 15 {
                return light();
            }
        }
    }

    dark()
}

/// Query the controlling terminal for its background colour via OSC 11 and
/// return the perceived luminance (0.0 = black, 1.0 = white). Returns None if
/// we couldn't talk to a terminal or the response didn't parse.
#[cfg(unix)]
fn query_terminal_luma() -> Option<f32> {
    use std::io::{Read, Write};
    use std::os::unix::io::AsRawFd;
    use std::time::Instant;

    // Open /dev/tty so we work even when stdout is redirected.
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .ok()?;
    let fd = tty.as_raw_fd();

    // Snapshot termios so we can restore it.
    let mut orig: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut orig) } != 0 {
        return None;
    }
    let mut raw = orig;
    unsafe { libc::cfmakeraw(&mut raw) };
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
        return None;
    }

    // Send the query and read the response with a short timeout. Some
    // terminals (older tmux, screen without DCS passthrough) won't reply, so
    // we have to bail quickly to avoid stalling the TUI.
    let _ = tty.write_all(b"\x1b]11;?\x1b\\");
    let _ = tty.flush();

    let mut buf: Vec<u8> = Vec::with_capacity(64);
    let mut chunk = [0u8; 64];
    let timeout_ms: i32 = 150;
    let start = Instant::now();

    loop {
        let elapsed = start.elapsed().as_millis() as i32;
        let remaining = timeout_ms - elapsed;
        if remaining <= 0 {
            break;
        }
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let n = unsafe { libc::poll(&mut pfd, 1, remaining) };
        if n <= 0 {
            break;
        }
        let r = match tty.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(r) => r,
        };
        buf.extend_from_slice(&chunk[..r]);
        // Response terminates with BEL (0x07) or ST (ESC \).
        if buf.contains(&0x07) || buf.windows(2).any(|w| w == b"\x1b\\") {
            break;
        }
    }

    // Restore termios no matter what.
    unsafe { libc::tcsetattr(fd, libc::TCSANOW, &orig) };

    parse_osc11_luma(&buf)
}

#[cfg(not(unix))]
fn query_terminal_luma() -> Option<f32> {
    None
}

/// Parse `\x1b]11;rgb:RRRR/GGGG/BBBB\x07` (lengths may be 1-4 hex digits per
/// channel) and return relative luminance.
fn parse_osc11_luma(buf: &[u8]) -> Option<f32> {
    let s = std::str::from_utf8(buf).ok()?;
    let rest = s.split("rgb:").nth(1)?;
    let mut parts = rest.split('/');
    let r = parse_hex_channel(parts.next()?)?;
    let g = parse_hex_channel(parts.next()?)?;
    let b = parse_hex_channel(parts.next()?)?;
    // Rec. 709 luminance is a fine proxy for "is this a light or dark bg".
    Some(0.2126 * r + 0.7152 * g + 0.0722 * b)
}

fn parse_hex_channel(s: &str) -> Option<f32> {
    let hex: String = s.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if hex.is_empty() {
        return None;
    }
    let raw = u32::from_str_radix(&hex, 16).ok()?;
    // Normalise: 1-hex => /15, 2-hex => /255, 4-hex => /65535, etc.
    let max = (1u32 << (4 * hex.len() as u32)).saturating_sub(1).max(1);
    Some(raw as f32 / max as f32)
}

pub fn dark() -> Theme {
    Theme {
        sel_bg:         "48;5;236",
        text_dim:       "38;5;240",
        text_faint:     "38;5;238",
        text_primary:   "38;5;255",
        text_secondary: "38;5;245",
        fresh:          "38;5;46",
        moderate:       "38;5;214",
        stale:          "38;5;239",
        error:          "38;5;196",
        header:         "1;38;5;229",
        accent:         "38;5;229",
        label:          "38;5;220",
        link:           "38;5;75",
        backed_name:    "1;38;5;255",
        backed_meta:    "38;5;240",
        unbacked_name:  "38;5;242",
        unbacked_meta:  "38;5;238",
        tool_ok:        "38;5;177",
        tidy_warn:      "1;38;5;203",
        stale_agent:    239,
        md_code:        116,
        md_text:        252,
        md_h1:          229,
        md_h2:          222,
        md_h3:          216,
        md_bold:        255,
        md_italic:      252,
    }
}

pub fn light() -> Theme {
    // Tuned for a white-ish background. Avoid the 136 mustard family — it's
    // unreadable on white. Headers and accents use darker amber/brown; the
    // soft "meta" colours stay above ~4:1 contrast so they're still legible.
    Theme {
        sel_bg:         "48;5;254",
        text_dim:       "38;5;238",
        text_faint:     "38;5;243",
        text_primary:   "38;5;232",
        text_secondary: "38;5;240",
        fresh:          "38;5;34",
        moderate:       "38;5;130",
        stale:          "38;5;243",
        error:          "38;5;124",
        header:         "1;38;5;94",
        accent:         "38;5;94",
        label:          "38;5;130",
        link:           "38;5;26",
        backed_name:    "1;38;5;232",
        backed_meta:    "38;5;240",
        unbacked_name:  "38;5;241",
        unbacked_meta:  "38;5;243",
        tool_ok:        "38;5;91",
        tidy_warn:      "1;38;5;124",
        stale_agent:    243,
        md_code:        23,
        md_text:        234,
        md_h1:          94,
        md_h2:          130,
        md_h3:          94,
        md_bold:        232,
        md_italic:      238,
    }
}
