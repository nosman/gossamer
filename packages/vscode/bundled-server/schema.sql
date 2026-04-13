
-- CreateTable
CREATE TABLE IF NOT EXISTS "InteractionOverview" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CheckpointMetadata" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cliVersion" TEXT,
    "checkpointId" TEXT NOT NULL,
    "strategy" TEXT,
    "branch" TEXT,
    "checkpointsCount" INTEGER NOT NULL DEFAULT 0,
    "gitUserName" TEXT,
    "gitUserEmail" TEXT,
    "tokenUsageId" INTEGER,
    CONSTRAINT "CheckpointMetadata_tokenUsageId_fkey" FOREIGN KEY ("tokenUsageId") REFERENCES "TokenUsage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SessionLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointMetadataId" INTEGER,
    "metadata" TEXT,
    "transcript" TEXT,
    "context" TEXT,
    "contentHash" TEXT,
    "prompt" TEXT,
    CONSTRAINT "SessionLink_checkpointMetadataId_fkey" FOREIGN KEY ("checkpointMetadataId") REFERENCES "CheckpointMetadata" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CheckpointMetadataFilePath" (
    "checkpointMetadataId" INTEGER NOT NULL,
    "filePathId" INTEGER NOT NULL,

    PRIMARY KEY ("checkpointMetadataId", "filePathId"),
    CONSTRAINT "CheckpointMetadataFilePath_checkpointMetadataId_fkey" FOREIGN KEY ("checkpointMetadataId") REFERENCES "CheckpointMetadata" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CheckpointMetadataFilePath_filePathId_fkey" FOREIGN KEY ("filePathId") REFERENCES "FilePath" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FilePath" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "path" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TokenUsage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "apiCallCount" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CheckpointSessionMetadata" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cliVersion" TEXT,
    "checkpointId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "strategy" TEXT,
    "createdAt" DATETIME,
    "branch" TEXT,
    "checkpointsCount" INTEGER NOT NULL DEFAULT 0,
    "agent" TEXT,
    "turnId" TEXT,
    "tokenUsageId" INTEGER,
    CONSTRAINT "CheckpointSessionMetadata_tokenUsageId_fkey" FOREIGN KEY ("tokenUsageId") REFERENCES "TokenUsage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CheckpointSessionMetadataFilePath" (
    "checkpointSessionMetadataId" INTEGER NOT NULL,
    "filePathId" INTEGER NOT NULL,

    PRIMARY KEY ("checkpointSessionMetadataId", "filePathId"),
    CONSTRAINT "CheckpointSessionMetadataFilePath_checkpointSessionMetadataId_fkey" FOREIGN KEY ("checkpointSessionMetadataId") REFERENCES "CheckpointSessionMetadata" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CheckpointSessionMetadataFilePath_filePathId_fkey" FOREIGN KEY ("filePathId") REFERENCES "FilePath" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InitialAttribution" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointSessionMetadataId" INTEGER NOT NULL,
    "calculatedAt" DATETIME,
    "agentLines" INTEGER NOT NULL DEFAULT 0,
    "humanAdded" INTEGER NOT NULL DEFAULT 0,
    "humanModified" INTEGER NOT NULL DEFAULT 0,
    "humanRemoved" INTEGER NOT NULL DEFAULT 0,
    "totalCommitted" INTEGER NOT NULL DEFAULT 0,
    "agentPercentage" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "InitialAttribution_checkpointSessionMetadataId_fkey" FOREIGN KEY ("checkpointSessionMetadataId") REFERENCES "CheckpointSessionMetadata" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CheckpointSessionSummary" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointSessionMetadataId" INTEGER NOT NULL,
    "intent" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    CONSTRAINT "CheckpointSessionSummary_checkpointSessionMetadataId_fkey" FOREIGN KEY ("checkpointSessionMetadataId") REFERENCES "CheckpointSessionMetadata" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OpenItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointSessionSummaryId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "subSessionId" TEXT,
    CONSTRAINT "OpenItem_checkpointSessionSummaryId_fkey" FOREIGN KEY ("checkpointSessionSummaryId") REFERENCES "CheckpointSessionSummary" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FrictionItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointSessionSummaryId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "FrictionItem_checkpointSessionSummaryId_fkey" FOREIGN KEY ("checkpointSessionSummaryId") REFERENCES "CheckpointSessionSummary" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RepoLearning" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointSessionMetadataId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "RepoLearning_checkpointSessionMetadataId_fkey" FOREIGN KEY ("checkpointSessionMetadataId") REFERENCES "CheckpointSessionSummary" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CodeLearning" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointSessionMetadataId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "finding" TEXT NOT NULL,
    CONSTRAINT "CodeLearning_checkpointSessionMetadataId_fkey" FOREIGN KEY ("checkpointSessionMetadataId") REFERENCES "CheckpointSessionSummary" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkflowItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "checkpointSessionMetadataId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "WorkflowItem_checkpointSessionMetadataId_fkey" FOREIGN KEY ("checkpointSessionMetadataId") REFERENCES "CheckpointSessionSummary" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CheckpointIdGitOidJoin" (
    "gitOid" TEXT NOT NULL PRIMARY KEY,
    "checkpointId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ArchivedSession" (
    "sessionId" TEXT NOT NULL PRIMARY KEY,
    "archivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SessionParent" (
    "childSessionId" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "toolUseId" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ShadowSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "seenBlobShas" TEXT NOT NULL DEFAULT '[]',
    "prompt" TEXT,
    "cwd" TEXT,
    "gitBranch" TEXT,
    "createdAt" DATETIME,
    "gitUserName" TEXT,
    "gitUserEmail" TEXT
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LogEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT,
    "messageId" TEXT,
    "sessionId" TEXT,
    "parentUuid" TEXT,
    "type" TEXT NOT NULL,
    "timestamp" DATETIME,
    "cwd" TEXT,
    "gitBranch" TEXT,
    "version" TEXT,
    "slug" TEXT,
    "isSidechain" BOOLEAN,
    "userType" TEXT,
    "toolUseId" TEXT,
    "parentToolUseId" TEXT,
    "requestId" TEXT,
    "data" TEXT NOT NULL,
    "sessionLinkId" INTEGER,
    "shadowSessionId" INTEGER,
    CONSTRAINT "LogEvent_sessionLinkId_fkey" FOREIGN KEY ("sessionLinkId") REFERENCES "SessionLink" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LogEvent_shadowSessionId_fkey" FOREIGN KEY ("shadowSessionId") REFERENCES "ShadowSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LogContent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "logEventId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "contentIndex" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "text" TEXT,
    "thinking" TEXT,
    "toolUseId" TEXT,
    "toolName" TEXT,
    "toolInput" TEXT,
    "toolResultContent" TEXT,
    "isError" BOOLEAN,
    "imageData" TEXT,
    "imageMediaType" TEXT,
    CONSTRAINT "LogContent_logEventId_fkey" FOREIGN KEY ("logEventId") REFERENCES "LogEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LogUsage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "logEventId" INTEGER NOT NULL,
    "model" TEXT,
    "stopReason" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "LogUsage_logEventId_fkey" FOREIGN KEY ("logEventId") REFERENCES "LogEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LogHookProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "logEventId" INTEGER NOT NULL,
    "type" TEXT,
    "hookEvent" TEXT,
    "hookName" TEXT,
    "command" TEXT,
    CONSTRAINT "LogHookProgress_logEventId_fkey" FOREIGN KEY ("logEventId") REFERENCES "LogEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LogSystemEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "logEventId" INTEGER NOT NULL,
    "subtype" TEXT,
    "hookCount" INTEGER,
    "stopReason" TEXT,
    "preventedContinuation" BOOLEAN,
    "level" TEXT,
    "durationMs" INTEGER,
    CONSTRAINT "LogSystemEvent_logEventId_fkey" FOREIGN KEY ("logEventId") REFERENCES "LogEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InteractionOverview_sessionId_key" ON "InteractionOverview"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CheckpointMetadata_checkpointId_key" ON "CheckpointMetadata"("checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CheckpointMetadata_tokenUsageId_key" ON "CheckpointMetadata"("tokenUsageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SessionLink_checkpointMetadataId_idx" ON "SessionLink"("checkpointMetadataId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FilePath_path_key" ON "FilePath"("path");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CheckpointSessionMetadata_tokenUsageId_key" ON "CheckpointSessionMetadata"("tokenUsageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CheckpointSessionMetadata_sessionId_idx" ON "CheckpointSessionMetadata"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CheckpointSessionMetadata_checkpointId_sessionId_key" ON "CheckpointSessionMetadata"("checkpointId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InitialAttribution_checkpointSessionMetadataId_key" ON "InitialAttribution"("checkpointSessionMetadataId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CheckpointSessionSummary_checkpointSessionMetadataId_key" ON "CheckpointSessionSummary"("checkpointSessionMetadataId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpenItem_checkpointSessionSummaryId_idx" ON "OpenItem"("checkpointSessionSummaryId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OpenItem_checkpointSessionSummaryId_text_key" ON "OpenItem"("checkpointSessionSummaryId", "text");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FrictionItem_checkpointSessionSummaryId_idx" ON "FrictionItem"("checkpointSessionSummaryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RepoLearning_checkpointSessionMetadataId_idx" ON "RepoLearning"("checkpointSessionMetadataId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CodeLearning_checkpointSessionMetadataId_idx" ON "CodeLearning"("checkpointSessionMetadataId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkflowItem_checkpointSessionMetadataId_idx" ON "WorkflowItem"("checkpointSessionMetadataId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CheckpointIdGitOidJoin_checkpointId_idx" ON "CheckpointIdGitOidJoin"("checkpointId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SessionParent_parentSessionId_idx" ON "SessionParent"("parentSessionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ShadowSession_sessionId_key" ON "ShadowSession"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LogEvent_uuid_key" ON "LogEvent"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LogEvent_messageId_key" ON "LogEvent"("messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogEvent_sessionId_idx" ON "LogEvent"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogEvent_sessionId_timestamp_idx" ON "LogEvent"("sessionId", "timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogEvent_sessionId_id_idx" ON "LogEvent"("sessionId", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogEvent_type_idx" ON "LogEvent"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogEvent_sessionLinkId_idx" ON "LogEvent"("sessionLinkId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogEvent_shadowSessionId_idx" ON "LogEvent"("shadowSessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogContent_logEventId_idx" ON "LogContent"("logEventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LogContent_toolUseId_idx" ON "LogContent"("toolUseId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LogUsage_logEventId_key" ON "LogUsage"("logEventId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LogHookProgress_logEventId_key" ON "LogHookProgress"("logEventId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LogSystemEvent_logEventId_key" ON "LogSystemEvent"("logEventId");
