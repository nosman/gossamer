import gitlog from "gitlog";

export function getCheckpointIdFromCommitMessage(message: string): string | null {
  const match = message.match(/^Entire-Checkpoint:\s*(\S+)$/m);
  return match ? match[1] : null;
}

export async function findCommitForCheckpoint(
  repoPath: string,
  branch: string,
  checkpointId: string,
): Promise<{ hash: string; subject: string; branch: string } | null> {
  const branches = [branch, "main", "master"].filter(
    (b, i, arr) => arr.indexOf(b) === i,
  );

  for (const b of branches) {
    let commits: Awaited<ReturnType<typeof gitlog>>;
    try {
      commits = await gitlog({
        repo: repoPath,
        branch: b,
        fields: ["hash", "subject", "body"] as const,
        number: 10_000,
      });
    } catch {
      continue;
    }

    for (const commit of commits) {
      const id = getCheckpointIdFromCommitMessage(commit.body ?? "");
      if (id === checkpointId) {
        return { hash: commit.hash, subject: commit.subject, branch: b };
      }
    }
  }

  return null;
}
