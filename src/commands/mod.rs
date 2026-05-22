pub mod attach;
pub mod clean;
pub mod index;
pub mod init;
pub mod refresh;
pub mod search;
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
