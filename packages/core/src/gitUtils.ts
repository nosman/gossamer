import gitlog from "gitlog";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

export function getCheckpointIdFromCommitMessage(message: string): string | null {
  const match = message.match(/^Entire-Checkpoint:\s*(\S+)$/m);
  return match ? match[1] : null;
}

/**
 * Look up the author of a checkpoint commit on the `entire/checkpoints/v1` branch.
 * The checkpoint worktree shares the object store with the bare/main repo, so
 * `git log` inside `worktreePath` can see all checkpoint-branch commits.
 *
 * Each checkpoint commit has a subject like `Checkpoint: <id>`.
 */
export async function findCheckpointAuthor(
  worktreePath: string,
  checkpointId: string,
): Promise<{ name: string; email: string } | null> {
  try {
    const { stdout } = await execFile(
      "git",
      ["-C", worktreePath, "log", "-1", "--format=%an%x00%ae", "--grep", `^Checkpoint: ${checkpointId}$`, "--all"],
      { maxBuffer: 1024 * 1024 },
    );
    const line = stdout.trim();
    if (!line) return null;
    const [name, email] = line.split("\0");
    if (!name && !email) return null;
    return { name: name ?? "", email: email ?? "" };
  } catch {
    return null;
  }
}

export async function findCommitForCheckpoint(
  repoPath: string,
  branch: string,
  checkpointId: string,
): Promise<{ hash: string; subject: string; branch: string; authorName: string; authorEmail: string } | null> {
  const branches = [branch, "main", "master"].filter(
    (b, i, arr) => arr.indexOf(b) === i,
  );

  for (const b of branches) {
    let commits: Awaited<ReturnType<typeof gitlog>>;
    try {
      commits = await gitlog({
        repo: repoPath,
        branch: b,
        fields: ["hash", "subject", "body", "authorName", "authorEmail"] as const,
        number: 10_000,
        nameStatus: false,
        execOptions: { maxBuffer: 100 * 1024 * 1024 },
      });
    } catch {
      continue;
    }

    for (const commit of commits) {
      const id = getCheckpointIdFromCommitMessage(commit.body ?? "");
      if (id === checkpointId) {
        return {
          hash: commit.hash,
          subject: commit.subject,
          branch: b,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
        };
      }
    }
  }

  return null;
}
