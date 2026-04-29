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

  // Match the trailer line that the indexer parses (`^Entire-Checkpoint: <id>$`).
  // `-F` keeps the id literal, `-E` enables anchors, `--grep` narrows to commits
  // whose body contains the trailer — no full history scan in JS.
  const grep = `^Entire-Checkpoint: ${checkpointId}$`;
  const FORMAT = "%H%x00%s%x00%an%x00%ae";

  for (const b of branches) {
    try {
      const { stdout } = await execFile(
        "git",
        ["-C", repoPath, "log", "-1", `--format=${FORMAT}`, "-E", "--grep", grep, b, "--"],
        { maxBuffer: 1024 * 1024 },
      );
      const line = stdout.trim();
      if (!line) continue;
      const [hash, subject, authorName, authorEmail] = line.split("\0");
      if (!hash) continue;
      return {
        hash,
        subject:     subject     ?? "",
        branch:      b,
        authorName:  authorName  ?? "",
        authorEmail: authorEmail ?? "",
      };
    } catch {
      // ref unknown / git unavailable — try the next candidate
    }
  }

  return null;
}
