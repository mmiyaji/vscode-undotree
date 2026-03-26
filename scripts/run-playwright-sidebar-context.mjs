#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

function getVsCodeExecutablePath() {
  if (process.env.VSCODE_E2E_PATH) {
    return process.env.VSCODE_E2E_PATH;
  }
  return path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe");
}

async function openFile(page, name) {
  await page.keyboard.press("Control+P");
  await page.waitForTimeout(300);
  await page.keyboard.type(name);
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

async function appendAndSave(page, text) {
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+S");
  await page.waitForTimeout(1200);
}

async function toggleUndoTreeView(page) {
  const header = page.locator("text=/UNDO TREE|Undo Tree/").first();
  await header.click();
  await page.waitForTimeout(700);
}

async function readUndoTreeText(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidateFrames = page.frames().filter((frame) => frame.url().includes("fake.html"));
    for (const frame of candidateFrames.reverse()) {
      try {
        const text = await frame.locator("body").innerText({ timeout: 300 });
        if (text.includes("Undo") && text.includes("Redo")) {
          return text;
        }
      } catch {
        // Try the next frame; VS Code keeps stale fake frames around while switching views.
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error("Undo Tree webview frame was not found.");
}

async function main() {
  const repo = process.cwd();
  const vscodePath = getVsCodeExecutablePath();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "undotree-e2e-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const userDataDir = path.join(tempRoot, "user-data");
  const extensionsDir = path.join(tempRoot, "extensions");
  let app;

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });

    await fs.writeFile(path.join(workspaceDir, "a.md"), "# A\nline a\n", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "b.md"),
      Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
      "utf8"
    );

    app = await electron.launch({
      executablePath: vscodePath,
      args: [
        workspaceDir,
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
        "--disable-workspace-trust",
        "--skip-welcome",
        `--extensionDevelopmentPath=${repo}`,
      ],
    });

    const page = await app.firstWindow();
    await page.waitForTimeout(8000);

    await openFile(page, "a.md");
    await appendAndSave(page, "\nline a2");
    await appendAndSave(page, "\nline a3");

    await page.keyboard.press("Control+Shift+U");
    await page.waitForTimeout(1500);
    const textA = await readUndoTreeText(page);

    await toggleUndoTreeView(page);

    await openFile(page, "b.md");
    await page.waitForTimeout(1000);
    await toggleUndoTreeView(page);
    await page.waitForTimeout(2000);
    const textB = await readUndoTreeText(page);

    assert.match(textA, /5 L/);
    assert.match(textA, /save/i);
    assert.match(textB, /21 L/);
    assert.doesNotMatch(textB, /5 L/);
    console.log("Playwright E2E passed: Undo Tree follows the newly opened file when the view is collapsed and reopened.");
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
