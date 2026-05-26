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

    // COLORFGBG="fg;bg" — background index 7 (white) or 15 (bright white) → light theme
    if let Ok(v) = std::env::var("COLORFGBG") {
        if let Some(bg) = v.rsplit(';').next().and_then(|s| s.trim().parse::<u8>().ok()) {
            if bg == 7 || bg == 15 {
                return light();
            }
        }
    }

    dark()
}

pub fn dark() -> Theme {
    Theme {
        sel_bg:         "48;5;236",
        text_dim:       "38;5;240",
        text_faint:     "38;5;238",
        text_primary:   "38;5;255",
        text_secondary: "38;5;245",
        fresh:          "38;5;82",
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
    Theme {
        sel_bg:         "48;5;252",
        text_dim:       "38;5;238",
        text_faint:     "38;5;244",
        text_primary:   "38;5;232",
        text_secondary: "38;5;240",
        fresh:          "38;5;28",
        moderate:       "38;5;130",
        stale:          "38;5;244",
        error:          "38;5;124",
        header:         "1;38;5;136",
        accent:         "38;5;136",
        label:          "38;5;130",
        link:           "38;5;26",
        backed_name:    "1;38;5;232",
        backed_meta:    "38;5;238",
        unbacked_name:  "38;5;244",
        unbacked_meta:  "38;5;247",
        tool_ok:        "38;5;91",
        tidy_warn:      "1;38;5;166",
        stale_agent:    244,
        md_code:        23,
        md_text:        234,
        md_h1:          94,
        md_h2:          130,
        md_h3:          136,
        md_bold:        232,
        md_italic:      238,
    }
}
