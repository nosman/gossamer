use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;
mod config;
mod db;
mod entity;
mod ingest;
mod parsers;
mod theme;
mod watermark;

#[derive(Parser)]
#[command(name = "gossamer", about = "Manage AI sessions with entireio")]
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
    /// Start a new AI coding session, optionally in a fresh git worktree
    NewSession {
        /// Agent to use: claude, gemini, aider [default: claude]
        #[arg(long, short = 'a')]
        agent: Option<String>,
        /// Create a new git worktree on this branch before launching
        #[arg(long, short = 'b')]
        branch: Option<String>,
        /// Session name (passed as -n to the agent)
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
    /// Push a session's checkpoint to the remote so another agent can resume it
    Handoff {
        /// Session ID (full UUID or unambiguous prefix)
        session_id: String,
        /// Force push even if the remote has diverged
        #[arg(short, long)]
        force: bool,
    },
    /// Show or set gossamer configuration
    Config {
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
        Commands::Index => commands::index::run(json)?,
        Commands::Refresh => commands::refresh::run(json)?,
        Commands::Show { session } => { commands::show::run(&session)?; }
        Commands::Search { query, top_k } => { commands::search::run(&query.join(" "), top_k, json)?; }
        Commands::NewSession { agent, branch, name, prompt } => {
            commands::new_session::run(agent, branch, name, prompt)?
        }
        Commands::Resume { session_id } => commands::resume::run(&session_id)?,
        Commands::Clean { session_id } => commands::clean::run(&session_id, json)?,
        Commands::Tidy { dry_run, days, force, sessions } => commands::tidy::run(days, dry_run, force, sessions, json)?,
        Commands::Attach { session_id, agent, force } => commands::attach::run(&session_id, &agent, force, json)?,
        Commands::Handoff { session_id, force } => commands::handoff::run(&session_id, force, json)?,
        Commands::Config { assets: Some(path) } => config::set_warp_assets(&path)?,
        Commands::Config { assets: None }       => config::show(),
        Commands::SessionStart => commands::session_start::run()?,
        Commands::SessionStop  => commands::session_stop::run()?,
    }
    Ok(())
}
