use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;
mod config;
mod db;
mod entity;
mod ingest;
mod parsers;
mod scraper;
mod theme;
mod watermark;

#[derive(Parser)]
#[command(
    name = "entire-gossamer",
    about = "Manage AI sessions with entireio. Run with no subcommand to open the interactive repo browser."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Output as JSON instead of an interactive TUI
    #[arg(long, global = true)]
    json: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize gossamer in the current git repository
    Init,
    /// Open the interactive repo browser (also the default when no subcommand is given)
    Repo,
    /// Print sessions from the past 3 days
    Sessions {
        /// Show all sessions regardless of age
        #[arg(long)]
        all: bool,
    },
    /// Scan checkpoint logs and Claude JSONL files and ingest sessions into the database
    Ingest {
        /// Only ingest checkpoint commits since the last ingest (skips unchanged repos)
        #[arg(long)]
        incremental: bool,
    },
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
    /// Launch a new Claude Code session, optionally in a fresh git worktree
    Launch {
        /// Create a new git worktree on this branch before launching
        #[arg(long, short = 'b')]
        branch: Option<String>,
        /// Session name (passed as -n to claude)
        #[arg(long, short = 'n')]
        name: Option<String>,
        /// Initial prompt, also copied to clipboard
        prompt: Option<String>,
    },
    /// Resume a session, checking out a new worktree if needed
    Resume {
        /// Session ID (full UUID or unambiguous prefix)
        session_id: String,
    },
    /// Remove a session: runs `entire clean`, deletes from DB, removes search index entries
    Clean {
        /// Session ID to clean up
        session_id: String,
    },
    /// Remove sessions from the DB that no longer exist in any checkpoint or Claude session file
    Purge {
        /// List stale sessions without deleting them
        #[arg(long)]
        dry_run: bool,
    },
    /// Scan Claude Code session history for untracked GitHub repos and register them
    Discover {
        /// List candidates without registering them
        #[arg(long)]
        dry_run: bool,
    },
    /// Remove git worktrees that have had no recent session activity
    Tidy {
        /// Only list stale worktrees without removing them
        #[arg(long)]
        dry_run: bool,
        /// Days of inactivity before a worktree is considered stale
        #[arg(long, default_value = "7")]
        days: i64,
        /// Pass --force to git worktree remove (removes worktrees with uncommitted changes)
        #[arg(long)]
        force: bool,
        /// Also remove sessions whose cwd was inside each removed worktree
        #[arg(long)]
        sessions: bool,
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
    /// Show or set the witchcraft (semantic search) assets directory
    Assets {
        /// Path to the witchcraft assets directory (enables semantic search)
        assets: Option<String>,
    },
    /// Called by the Claude Code SessionStart hook — reads JSON from stdin
    #[command(hide = true)]
    SessionStart,
    /// Called by the Claude Code Stop hook — ingests the finished session
    #[command(hide = true)]
    SessionStop,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let json = cli.json;
    // Detect the terminal theme before any command enables raw mode.
    // termbg queries the terminal via OSC 11, which requires non-raw mode.
    // Non-interactive contexts (pipes, hooks) skip this; termbg returns fast on no-tty.
    if !json && std::io::IsTerminal::is_terminal(&std::io::stdout()) {
        theme::get();
    }
    match cli.command.unwrap_or(Commands::Repo) {
        Commands::Init => commands::init::run(json)?,
        Commands::Repo => { commands::status::run(json)?; }
        Commands::Sessions { all } => { commands::sessions::run(all, json)?; }
        Commands::Ingest { incremental: false } => commands::index::run(json)?,
        Commands::Ingest { incremental: true } => commands::refresh::run(json)?,
        Commands::Show { session } => { commands::show::run(&session)?; }
        Commands::Search { query, top_k } => { commands::search::run(&query.join(" "), top_k, json)?; }
        Commands::Launch { branch, name, prompt } => {
            commands::new_session::run(branch, name, prompt)?
        }
        Commands::Resume { session_id } => commands::resume::run(&session_id)?,
        Commands::Clean { session_id } => commands::clean::run(&session_id, json)?,
        Commands::Purge { dry_run } => commands::purge::run(dry_run, json)?,
        Commands::Discover { dry_run } => commands::discover::run(dry_run, json)?,
        Commands::Tidy { dry_run, days, force, sessions } => commands::tidy::run(days, dry_run, force, sessions, json)?,
        Commands::Attach { session_id, agent, force } => commands::attach::run(&session_id, &agent, force, json)?,
        Commands::Assets { assets: Some(path) } => config::set_warp_assets(&path)?,
        Commands::Assets { assets: None }       => config::show(),
        Commands::SessionStart => commands::session_start::run()?,
        Commands::SessionStop  => commands::session_stop::run()?,
    }
    Ok(())
}
