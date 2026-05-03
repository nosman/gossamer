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
    /// Print all sessions
    Sessions,
    /// Scan checkpoint logs and index sessions into the database
    Index,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Init => commands::init::run().await?,
        Commands::Repo => commands::status::run().await?,
        Commands::Sessions => commands::sessions::run().await?,
        Commands::Index => commands::index::run().await?,
    }
    Ok(())
}
