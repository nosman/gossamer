use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;
mod db;
mod entity;
mod migration;

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
    /// Called by the Claude Code SessionStart hook — reads JSON from stdin
    #[command(hide = true)]
    SessionStart,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Init => commands::init::run().await?,
        Commands::Repo => commands::status::run().await?,
        Commands::Sessions { all } => commands::sessions::run(all).await?,
        Commands::Index => commands::index::run().await?,
        Commands::SessionStart => commands::session_start::run().await?,
    }
    Ok(())
}
