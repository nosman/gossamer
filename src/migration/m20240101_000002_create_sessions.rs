use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Sessions::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Sessions::SessionId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Sessions::AgentName).string().not_null())
                    .col(ColumnDef::new(Sessions::User).string().not_null())
                    .col(ColumnDef::new(Sessions::CreatedAt).date_time().not_null())
                    .col(ColumnDef::new(Sessions::UpdatedAt).date_time().not_null())
                    .col(ColumnDef::new(Sessions::Cwd).string().not_null())
                    .col(ColumnDef::new(Sessions::SessionName).string().not_null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Sessions::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Sessions {
    Table,
    SessionId,
    AgentName,
    User,
    CreatedAt,
    UpdatedAt,
    Cwd,
    SessionName,
}
