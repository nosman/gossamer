import * as vscode from "vscode";
import { get as httpGet } from "http";

const SCHEME = "gossamer-diff";
const SUMMARY_SCHEME = "gossamer-summary";

export class GossamerDiffProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();

  set(uri: vscode.Uri, text: string): void {
    this.content.set(uri.toString(), text);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }
}

export const diffProvider = new GossamerDiffProvider();
export const summaryProvider = new GossamerDiffProvider();

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

export async function openCheckpointSummary(checkpointId: string, text: string): Promise<void> {
  const uri = vscode.Uri.parse(`${SUMMARY_SCHEME}:summary-${checkpointId.slice(0, 8)}.txt`);
  summaryProvider.set(uri, text);
  await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: false });
}

export async function openCheckpointDiff(port: number, checkpointId: string, filePath: string): Promise<void> {
  const [before, after] = await Promise.all([
    fetchContent(port, checkpointId, filePath, "before"),
    fetchContent(port, checkpointId, filePath, "after"),
  ]);

  const fileName  = filePath.split("/").pop() ?? filePath;
  const shortId   = checkpointId.slice(0, 8);
  // Include filePath in the URI so VS Code infers the language from the extension
  const beforeUri = vscode.Uri.parse(`${SCHEME}:before-${shortId}/${filePath}`);
  const afterUri  = vscode.Uri.parse(`${SCHEME}:after-${shortId}/${filePath}`);

  diffProvider.set(beforeUri, before);
  diffProvider.set(afterUri, after);

  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeUri,
    afterUri,
    `${fileName} (checkpoint ${shortId})`,
  );
}
