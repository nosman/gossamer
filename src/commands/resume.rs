use anyhow::Result;
use std::path::PathBuf;

pub fn run(session_id: &str) -> Result<()> {
    let resolved = resolve_session_id(session_id)
        .ok_or_else(|| anyhow::anyhow!("no session found matching '{session_id}'"))?;

    let fallback_cwd = std::env::current_dir()?.to_string_lossy().to_string();
    super::show::resume_session(&resolved, &fallback_cwd);
    Ok(())
}

fn resolve_session_id(id: &str) -> Option<String> {
    // Exact or prefix match against JSONL files in ~/.claude/projects/
    let home = std::env::var("HOME").ok()?;
    let projects = PathBuf::from(&home).join(".claude/projects");

    if let Ok(project_entries) = std::fs::read_dir(&projects) {
        for project_entry in project_entries.flatten() {
            let dir = project_entry.path();
            if !dir.is_dir() { continue; }
            let Ok(files) = std::fs::read_dir(&dir) else { continue; };
            for file_entry in files.flatten() {
                let path = file_entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if stem == id || stem.starts_with(id) {
                        return Some(stem.to_string());
                    }
                }
            }
        }
    }

    // Fall back to gossamer DB prefix match
    let conn = crate::db::connect().ok()?;
    conn.query_row(
        "SELECT session_id FROM sessions WHERE session_id LIKE ?1 || '%' LIMIT 1",
        [id],
        |row| row.get::<_, String>(0),
    ).ok()
}
