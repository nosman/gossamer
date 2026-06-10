use std::sync::OnceLock;
use std::time::Duration;

// ── SGR parameter strings for the standard 16 ANSI colors ────────────────────
// These map to whatever palette the user's terminal defines (Solarized, Nord,
// Dracula, etc.) — the terminal theme controls the actual RGB values.

// Foreground — standard
const BLACK:   &str = "30";
const RED:     &str = "31";
const GREEN:   &str = "32";
const YELLOW:  &str = "33";
const BLUE:    &str = "34";
const MAGENTA: &str = "35";
const CYAN:    &str = "36";
const WHITE:   &str = "37"; // color-7: "gray" in dark themes, base text in Solarized

// Foreground — bright ("intense") variants
const BRIGHT_BLACK:   &str = "90"; // dark gray — universally readable as "dim"
const BRIGHT_GREEN:   &str = "92";
const BRIGHT_CYAN:    &str = "96";
const BRIGHT_WHITE:   &str = "97";

// Background
const BG_BRIGHT_BLACK: &str = "100"; // dark gray bg — visible selection on both dark and light

// Bold + color composites (bold attribute + standard color in one SGR string)
const BOLD_YELLOW: &str = "1;33";
const BOLD_BLUE:   &str = "1;34";
const BOLD_RED:    &str = "1;31";
const BOLD_WHITE:  &str = "1;97";
const BOLD_BLACK:  &str = "1;30";

// ── Theme struct ──────────────────────────────────────────────────────────────

pub struct Theme {
    /// Row selection background ("48;5;N" or base-16 bg code)
    pub sel_bg: &'static str,
    /// Dim text color when rendered on top of sel_bg (replaces text_dim/text_faint so it stays readable)
    pub sel_text_dim: &'static str,

    /// Metadata, timestamps, paths, decorative separators
    pub text_dim: &'static str,
    /// Very secondary ("… N more lines", non-backed meta)
    pub text_faint: &'static str,
    /// Normal readable foreground text
    pub text_primary: &'static str,
    /// Tool input secondary argument lines
    pub text_secondary: &'static str,

    /// Recent/active indicator — green
    pub fresh: &'static str,
    /// Moderate age / soft warning — yellow/amber
    pub moderate: &'static str,
    /// Inactive branch / stale state — gray
    pub stale: &'static str,
    /// Errors, detached HEAD — red
    pub error: &'static str,

    /// Bold section/page headers
    pub header: &'static str,
    /// Non-bold accent: main branch name
    pub accent: &'static str,
    /// Inline label color: branch tags, tool names
    pub label: &'static str,
    /// Linked worktrees, backed-up branches
    pub link: &'static str,

    /// Backed-up session name column (bold)
    pub backed_name: &'static str,
    /// Backed-up session metadata column
    pub backed_meta: &'static str,
    /// Non-backed session name column
    pub unbacked_name: &'static str,
    /// Non-backed session metadata column
    pub unbacked_meta: &'static str,

    /// Non-error tool result — magenta/purple
    pub tool_ok: &'static str,
    /// Bold tidy panel warning title — red
    pub tidy_warn: &'static str,

    // ── Markdown skin (crossterm Color, passed directly to MadSkin) ──────────
    pub md_code: crossterm::style::Color,
    pub md_text: crossterm::style::Color,
    pub md_h1:   crossterm::style::Color,
    pub md_h2:   crossterm::style::Color,
    pub md_h3:   crossterm::style::Color,
    pub md_bold: crossterm::style::Color,
    pub md_italic: crossterm::style::Color,
}

// ── Palettes ──────────────────────────────────────────────────────────────────

pub fn dark() -> Theme {
    use crossterm::style::Color;
    Theme {
        sel_bg:         BG_BRIGHT_BLACK,  // dark gray bg — subtle selection on dark terminal
        sel_text_dim:   BRIGHT_WHITE,     // bright white — maximally readable on dark gray sel bg
        text_dim:       BRIGHT_BLACK,     // gray — metadata, separators
        text_faint:     BRIGHT_BLACK,     // same gray — "N more lines" etc.
        text_primary:   BRIGHT_WHITE,     // near-white — primary readable text
        text_secondary: WHITE,            // color-7 — slightly dimmer than primary
        fresh:          BRIGHT_GREEN,     // vivid green — very recent
        moderate:       YELLOW,           // yellow — moderate age
        stale:          BRIGHT_BLACK,     // gray — inactive
        error:          RED,              // red — detached, errors
        header:         BOLD_YELLOW,      // bold yellow — section titles
        accent:         YELLOW,           // yellow — main branch
        label:          CYAN,             // cyan — inline labels, tool names
        link:           BRIGHT_CYAN,      // bright cyan — linked worktrees, backed-up branches
        backed_name:    BOLD_WHITE,       // bold bright white — prominent session name
        backed_meta:    BRIGHT_BLACK,     // gray — id, timestamp
        unbacked_name:  WHITE,            // color-7 — dimmer, not backed up
        unbacked_meta:  BRIGHT_BLACK,     // gray
        tool_ok:        MAGENTA,          // magenta — non-error tool result
        tidy_warn:      "1;91",           // bold bright red — destructive action warning
        md_code:        Color::Cyan,
        md_text:        Color::Grey,
        md_h1:          Color::Yellow,
        md_h2:          Color::DarkYellow,
        md_h3:          Color::DarkCyan,
        md_bold:        Color::White,
        md_italic:      Color::Grey,
    }
}

pub fn light() -> Theme {
    use crossterm::style::Color;
    Theme {
        sel_bg:         BG_BRIGHT_BLACK,  // dark gray bg — clearly visible on light terminal
        sel_text_dim:   BRIGHT_WHITE,     // bright white — maximally readable on dark gray sel bg
        text_dim:       BRIGHT_BLACK,     // dark gray — same, readable on light bg
        text_faint:     BRIGHT_BLACK,
        text_primary:   BLACK,            // near-black — primary text on light bg
        text_secondary: BRIGHT_BLACK,     // dark gray
        fresh:          GREEN,            // dark green — more readable on light than bright green
        moderate:       YELLOW,           // yellow — same
        stale:          WHITE,            // color-7 — subtle on light
        error:          RED,              // dark red — better contrast on light than bright red
        header:         BOLD_BLUE,        // bold blue — yellow has poor contrast on white bg
        accent:         BLUE,             // blue — main branch on light bg
        label:          CYAN,             // cyan — same
        link:           BLUE,             // blue — more readable than cyan on light bg
        backed_name:    BOLD_BLACK,       // bold black — prominent on light bg
        backed_meta:    BRIGHT_BLACK,     // dark gray
        unbacked_name:  BRIGHT_BLACK,     // dark gray
        unbacked_meta:  BRIGHT_BLACK,
        tool_ok:        MAGENTA,          // same
        tidy_warn:      BOLD_RED,         // bold red
        md_code:        Color::DarkCyan,
        md_text:        Color::Black,
        md_h1:          Color::DarkBlue,
        md_h2:          Color::DarkBlue,
        md_h3:          Color::DarkCyan,
        md_bold:        Color::Black,
        md_italic:      Color::DarkGrey,
    }
}

// ── Detection ─────────────────────────────────────────────────────────────────

static THEME: OnceLock<Theme> = OnceLock::new();

pub fn get() -> &'static Theme {
    THEME.get_or_init(detect)
}

fn detect() -> Theme {
    // 1. Explicit user override — always wins
    if let Ok(v) = std::env::var("GOSSAMER_THEME") {
        match v.to_lowercase().as_str() {
            "light" => return light(),
            "dark"  => return dark(),
            _ => {}
        }
    }

    // 2. OSC 11 query — ask the terminal for its background color
    //    termbg sends ESC ]11;?ST, reads the RGB response, and classifies it.
    //    This works on most modern terminals (kitty, Alacritty, iTerm2, VTE, xterm).
    //    Terminals that ignore OSC 11 cause a timeout; we fall through to step 3.
    if let Ok(termbg::Theme::Light) = termbg::theme(Duration::from_millis(100)) {
        return light();
    }

    // 3. COLORFGBG="fg;bg" — set by some older terminals (rxvt, etc.)
    //    Background index 7 (white) or 15 (bright white) → light theme.
    if let Ok(v) = std::env::var("COLORFGBG") {
        if let Some(bg) = v.rsplit(';').next().and_then(|s| s.trim().parse::<u8>().ok()) {
            if bg == 7 || bg == 15 {
                return light();
            }
        }
    }

    // 4. Default to dark
    dark()
}
