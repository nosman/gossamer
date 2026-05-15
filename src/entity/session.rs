use chrono::{DateTime, Utc};

pub struct Session {
    pub session_id: String,
    pub agent_name: String,
    pub user: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub cwd: String,
    pub session_name: String,
    pub tokens_used: i64,
}
