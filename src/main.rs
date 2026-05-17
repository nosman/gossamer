use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;
mod db;
mod entity;
mod ingest;
mod watermark;

#[derive(Parser)]
#[command(name = "gossamer", about = "Manage AI sessions with entireio")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize gossamer in the current git repository
    Init,
    /// Print all repositories tracked by gossamer
    Repo,
    /// Print sessions from the past 3 days
    Sessions {
        /// Show all sessions regardless of age
        #[arg(long)]
        all: bool,
    },
    /// Scan checkpoint logs and index sessions into the database
    Index,
    /// Incrementally index only new checkpoint commits since the last index/refresh
    Refresh,
    /// Browse a session's messages interactively (arrow keys to navigate)
    Show {
        /// Session ID or path to a JSONL file
        session: String,
    },
    /// Semantic search across indexed sessions
    Search {
        /// Search query (separate words are joined into one query)
        #[arg(required = true)]
        query: Vec<String>,
        /// Number of results to return
        #[arg(short = 'n', long, default_value = "10")]
        top_k: usize,
    },
    /// Attach an existing session with entireio and index it into witchcraft
    Attach {
        /// Session ID to attach
        session_id: String,
        /// Agent name passed to `entire attach`
        #[arg(short, long, default_value = "claude-code")]
        agent: String,
        /// Pass --force to `entire attach`
        #[arg(short, long)]
        force: bool,
    },
    /// Called by the Claude Code SessionStart hook — reads JSON from stdin
    #[command(hide = true)]
    SessionStart,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Init => commands::init::run()?,
        Commands::Repo => commands::status::run()?,
        Commands::Sessions { all } => commands::sessions::run(all)?,
        Commands::Index => commands::index::run()?,
        Commands::Refresh => commands::refresh::run()?,
        Commands::Show { session } => commands::show::run(&session)?,
        Commands::Search { query, top_k } => commands::search::run(&query.join(" "), top_k)?,
        Commands::Attach { session_id, agent, force } => commands::attach::run(&session_id, &agent, force)?,
        Commands::SessionStart => commands::session_start::run()?,
    }
    Ok(())
}
