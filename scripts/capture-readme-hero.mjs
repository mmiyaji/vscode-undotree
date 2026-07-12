#!/usr/bin/env node

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

async function runCommand(page, name) {
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(500);
  await page.keyboard.type(name, { delay: 10 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

async function openFile(page, name) {
  await page.keyboard.press("Control+P");
  await page.waitForTimeout(400);
  await page.keyboard.type(name, { delay: 10 });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1600);
}

async function waitForUndoTreeFrame(page) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidateFrames = page.frames().filter((frame) => frame.url().includes("fake.html"));
    for (const frame of candidateFrames.reverse()) {
      try {
        const text = await frame.locator("body").innerText({ timeout: 300 });
        if (text.includes("Undo") && text.includes("Redo")) {
          return frame;
        }
      } catch {
        // Ignore stale frames while VS Code is switching views.
      }
    }
    await page.waitForTimeout(400);
  }
  throw new Error("Undo Tree webview frame was not found.");
}

async function appendAndSave(page, text) {
  await page.keyboard.press("End");
  await page.keyboard.type(text, { delay: 4 });
  await page.waitForTimeout(250);
  await page.keyboard.press("Control+S");
  await page.waitForTimeout(1100);
}

async function focusUndoTree(frame) {
  await frame.locator("body").click({ position: { x: 60, y: 120 } });
  await frame.waitForTimeout(300);
}

async function jumpToEarlierNode(page, frame, stepsUp) {
  await focusUndoTree(frame);
  for (let i = 0; i < stepsUp; i += 1) {
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

async function waitForBranchyTree(frame) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = await frame.locator("body").innerText().catch(() => "");
    const saveCount = (text.match(/\bsave\b/gi) || []).length;
    if (saveCount >= 5 && text.includes("initial")) {
      return text;
    }
    await frame.waitForTimeout(300);
  }
  throw new Error("Undo Tree did not show the expected branchy sample.");
}

async function main() {
  const repo = process.cwd();
  const vscodePath = getVsCodeExecutablePath();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "undotree-readme-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const userDataDir = path.join(tempRoot, "user-data");
  const extensionsDir = path.join(tempRoot, "extensions");
  const heroPath = path.join(repo, "media", "undotree-readme-hero.png");
  let app;

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });

    const markdown = [
      "# UndoTree Demo",
      "",
      "This markdown file is used for the README hero image.",
      "",
      "## Why branching matters",
      "",
      "- Keep one branch intact",
      "- Continue from an older node",
      "- Compare branches later",
      "",
      "> The sidebar shows a persisted sample tree with multiple branches.",
      "",
      "```ts",
      "function saveCheckpoint(label: string) {",
      "  return `saved: ${label}`;",
      "}",
      "```",
      "",
      "- final polish",
      "",
    ].join("\n");
    const demoPath = path.join(workspaceDir, "readme-demo.md");
    await fs.writeFile(demoPath, markdown, "utf8");

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
        "--disable-updates",
        "--disable-telemetry",
        `--extensionDevelopmentPath=${repo}`,
      ],
    });

    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1580, height: 960 });
    await page.waitForTimeout(8000);

    await runCommand(page, "View: Close Secondary Side Bar");
    await runCommand(page, "View: Close Panel");
    await runCommand(page, "View: Appearance: Hide Status Bar");
    await runCommand(page, "View: Appearance: Hide Activity Bar");
    await openFile(page, "readme-demo.md");
    await page.waitForTimeout(1200);

    await appendAndSave(page, "\n## Stable branch\n\n- first checkpoint");
    await appendAndSave(page, "\n- second checkpoint");
    await appendAndSave(page, "\n- third checkpoint");

    await page.keyboard.press("Control+Shift+U");
    await page.waitForTimeout(1800);
    const frame = await waitForUndoTreeFrame(page);

    await jumpToEarlierNode(page, frame, 2);
    await appendAndSave(page, "\n## Alternate branch\n\n- branch from an older node");
    await appendAndSave(page, "\n- branch refined");

    await waitForBranchyTree(frame);
    await focusUndoTree(frame);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await runCommand(page, "View: Close Panel");
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    await page.screenshot({
      path: heroPath,
      fullPage: false,
      type: "png",
    });

    console.log(`Saved README hero screenshot: ${heroPath}`);
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
