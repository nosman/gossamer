pub mod attach;
pub mod clean;
pub mod discover;
pub mod purge;
pub mod tidy;
pub mod index;
pub mod init;
pub mod new_session;
pub mod refresh;
pub mod resume;
pub mod search;
pub mod session_list;
pub mod session_start;
pub mod session_stop;
pub mod show;
pub mod sessions;
pub mod status;

// ── Shared TUI helpers ────────────────────────────────────────────────────────

use std::io::{self, Write};
use crossterm::event::{self, Event, KeyCode};

/// Apply the selection background to a pre-colored ANSI string, substituting
/// dim foreground colors so they remain readable on the selection background.
pub(super) fn with_bg(s: &str, bg: &str) -> String {
    let t = crate::theme::get();
    let dim_esc   = format!("\x1b[{}m", t.text_dim);
    let faint_esc = format!("\x1b[{}m", t.text_faint);
    let sel_dim   = format!("\x1b[{}m", t.sel_text_dim);
    let reinsert  = format!("\x1b[0m\x1b[{bg}m");
    let body = s.replace("\x1b[0m", &reinsert)
                .replace(&dim_esc,   &sel_dim)
                .replace(&faint_esc, &sel_dim);
    format!("\x1b[{bg}m{body}")
}

/// Visible character width of an ANSI-escaped string (skips escape sequences).
pub(super) fn visible_width(s: &str) -> usize {
    let mut w = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for nc in chars.by_ref() { if nc.is_ascii_alphabetic() { break; } }
        } else {
            w += 1;
        }
    }
    w
}

/// Collapse `$HOME` to `~` in a path string.
pub(super) fn short_path(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
    }
}

/// Write one list row into a buffer: clears to end of line, then renders
/// with a selection background highlight if `selected`.
pub(super) fn render_row(buf: &mut impl Write, line: &str, selected: bool, row: usize, w: usize) -> io::Result<()> {
    use crossterm::{cursor, terminal::{self, ClearType}, queue};
    queue!(buf, cursor::MoveTo(0, row as u16), terminal::Clear(ClearType::UntilNewLine))?;
    if selected {
        let bg = crate::theme::get().sel_bg;
        let colored = with_bg(line, bg);
        let vis = visible_width(line);
        let pad = w.saturating_sub(vis);
        write!(buf, "\x1b[{bg}m{colored}{}\x1b[0m", " ".repeat(pad))?;
    } else {
        write!(buf, "{line}")?;
    }
    Ok(())
}

/// Write a reversed-video status bar at the bottom of the terminal into a buffer.
pub(super) fn draw_statusbar(buf: &mut impl Write, bar: &str, w: usize, h: usize) -> io::Result<()> {
    use crossterm::{cursor, queue};
    let display: String = bar.chars().take(w).collect();
    let padded = format!("{:<width$}", display, width = w);
    queue!(buf, cursor::MoveTo(0, (h - 1) as u16))?;
    write!(buf, "\x1b[7m{padded}\x1b[0m")?;
    Ok(())
}

/// Generic single-line input shown in the status bar. Returns None on Esc.
pub(super) fn collect_text_input(stdout: &mut impl Write, prefix: &str, w: usize, h: usize) -> Option<String> {
    use crossterm::{cursor, execute};
    let mut value = String::new();
    execute!(stdout, cursor::Show).ok();
    draw_input_bar(stdout, prefix, &value, w, h).ok();
    loop {
        match event::read().ok()? {
            Event::Key(k) => match k.code {
                KeyCode::Esc => { execute!(stdout, cursor::Hide).ok(); return None; }
                KeyCode::Enter => { execute!(stdout, cursor::Hide).ok(); return Some(value); }
                KeyCode::Backspace => { value.pop(); draw_input_bar(stdout, prefix, &value, w, h).ok(); }
                KeyCode::Char(c) => { value.push(c); draw_input_bar(stdout, prefix, &value, w, h).ok(); }
                _ => {}
            },
            _ => {}
        }
    }
}

fn draw_input_bar(stdout: &mut impl Write, prefix: &str, value: &str, w: usize, h: usize) -> io::Result<()> {
    use crossterm::{cursor, execute};
    let prefix_len = prefix.chars().count();
    let text: String = value.chars().take(w.saturating_sub(prefix_len + 2)).collect();
    let content = format!("{prefix}{text}");
    let padded = format!("{:<width$}", content, width = w);
    execute!(stdout, cursor::MoveTo(0, (h - 1) as u16))?;
    write!(stdout, "\x1b[7m{padded}\x1b[0m")?;
    let col = (prefix_len + text.chars().count()).min(w.saturating_sub(1)) as u16;
    execute!(stdout, cursor::MoveTo(col, (h - 1) as u16))?;
    stdout.flush()
}

pub(super) fn collect_search_query(stdout: &mut impl Write, w: usize, h: usize) -> Option<String> {
    collect_text_input(stdout, "  / ", w, h)
}

pub fn agent_color(name: &str) -> u8 {
    if      name.contains("Claude")   { 214 }
    else if name.contains("Copilot")  { 99  }
    else if name.contains("Cursor")   { 33  }
    else if name.contains("Gemini")   { 75  }
    else if name.contains("Aider")    { 42  }
    else if name.contains("ChatGPT")  { 35  }
    else if name.contains("Windsurf") { 44  }
    else if name.contains("Amazon Q") { 208 }
    else                              { 245 }
}

/// Deterministic per-author color so the same human always renders the same
/// hue across runs. Palette is chosen to be visually distinct from the agent
/// colors above and from the link/branch blue, while still readable on a
/// dark terminal background.
pub fn author_color(name: &str) -> u8 {
    if name.is_empty() { return 245; }
    const PALETTE: &[u8] = &[141, 113, 209, 110, 173, 219, 156, 180, 213, 117, 215, 78];
    // djb2 distributes better than sum-of-bytes — sum() happens to land
    // "Scott Holodak" and "Stephanos Tsoucas" in the same bucket.
    let mut hash: u32 = 5381;
    for b in name.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u32);
    }
    PALETTE[(hash as usize) % PALETTE.len()]
}
