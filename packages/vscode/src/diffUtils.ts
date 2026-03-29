import * as vscode from "vscode";
import { get as httpGet } from "http";
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function fetchContent(port: number, checkpointId: string, filePath: string, side: string): Promise<string> {
  return new Promise((resolve) => {
    const url = `http://localhost:${port}/api/v2/checkpoints/${encodeURIComponent(checkpointId)}/file?path=${encodeURIComponent(filePath)}&side=${side}`;
    httpGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", () => resolve(""));
  });
}

export async function openCheckpointDiff(port: number, checkpointId: string, filePath: string): Promise<void> {
  const fileName = filePath.split("/").pop() ?? filePath;
  const tmpDir = join(tmpdir(), "gossamer-diff");
  mkdirSync(tmpDir, { recursive: true });

  const [before, after] = await Promise.all([
    fetchContent(port, checkpointId, filePath, "before"),
    fetchContent(port, checkpointId, filePath, "after"),
  ]);

  const shortId    = checkpointId.slice(0, 8);
  const beforePath = join(tmpDir, `${shortId}-before-${fileName}`);
  const afterPath  = join(tmpDir, `${shortId}-after-${fileName}`);
  writeFileSync(beforePath, before);
  chmodSync(beforePath, 0o444);
  writeFileSync(afterPath, after);
  chmodSync(afterPath, 0o444);

  await vscode.commands.executeCommand(
    "vscode.diff",
    vscode.Uri.file(beforePath),
    vscode.Uri.file(afterPath),
    `${fileName} (checkpoint ${shortId})`,
  );
}
