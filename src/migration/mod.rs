use sea_orm_migration::prelude::*;

mod m20240101_000001_create_repositories;
mod m20240101_000002_create_sessions;

pub use sea_orm_migration::MigratorTrait;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20240101_000001_create_repositories::Migration),
            Box::new(m20240101_000002_create_sessions::Migration),
        ]
    }
}
