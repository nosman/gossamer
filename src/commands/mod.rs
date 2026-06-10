pub mod attach;
pub mod clean;
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
