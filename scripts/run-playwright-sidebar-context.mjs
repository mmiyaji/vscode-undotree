#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);

function getVsCodeExecutablePath() {
  if (process.env.VSCODE_E2E_PATH) {
    return process.env.VSCODE_E2E_PATH;
  }
  return path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe");
}

async function findVsCodeCliScript(vscodePath) {
  if (process.env.VSCODE_E2E_CLI_SCRIPT) {
    return process.env.VSCODE_E2E_CLI_SCRIPT;
  }
  const installDir = path.dirname(vscodePath);
  const entries = await fs.readdir(installDir, { withFileTypes: true });
  const candidates = [
    path.join(installDir, "resources", "app", "out", "cli.js"),
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(installDir, entry.name, "resources", "app", "out", "cli.js")),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next VS Code layout.
    }
  }
  throw new Error(`VS Code CLI script was not found below ${installDir}.`);
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
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+S");
  await page.waitForTimeout(1200);
}

async function toggleUndoTreeView(page) {
  const header = page.locator("text=/UNDO TREE|Undo Tree/").first();
  await header.click();
  await page.waitForTimeout(700);
}

async function getUndoTreeFrame(page) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidateFrames = page.frames().filter((frame) => frame.url().includes("fake.html"));
    for (const frame of candidateFrames.reverse()) {
      try {
        const text = await frame.locator("body").innerText({ timeout: 300 });
        if (text.includes("Undo") && text.includes("Redo")) {
          return frame;
        }
      } catch {
        // Try the next frame; VS Code keeps stale fake frames around while switching views.
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error("Undo Tree webview frame was not found.");
}

async function readUndoTreeText(page) {
  return (await getUndoTreeFrame(page)).locator("body").innerText();
}

async function showUndoTree(page) {
  await page.keyboard.press("Control+Shift+U");
  await page.waitForTimeout(1500);
  return getUndoTreeFrame(page);
}

async function waitForFileText(filePath, predicate, description) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const content = await fs.readFile(filePath, "utf8");
    if (predicate(content)) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function launchVsCode(vscodePath, repo, workspaceDir, userDataDir, extensionsDir, useInstalledVsix) {
  const app = await electron.launch({
    executablePath: vscodePath,
    timeout: 60_000,
    args: [
      workspaceDir,
      "--new-window",
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      ...(!useInstalledVsix ? [`--extensionDevelopmentPath=${repo}`] : []),
    ],
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForTimeout(8000);
  return { app, page };
}

async function runCase(name, operation) {
  await operation();
  console.log(`PASS: ${name}`);
}

async function main() {
  const repo = process.cwd();
  const vscodePath = getVsCodeExecutablePath();
  const vsixPath = process.env.VSCODE_E2E_VSIX
    ? path.resolve(process.env.VSCODE_E2E_VSIX)
    : undefined;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "undotree-e2e-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  const userDataDir = path.join(tempRoot, "user-data");
  const extensionsDir = path.join(tempRoot, "extensions");
  const aPath = path.join(workspaceDir, "a.md");
  const bPath = path.join(workspaceDir, "b.md");
  let app;

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });

    await fs.mkdir(path.join(userDataDir, "User"), { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, "User", "settings.json"),
      JSON.stringify({
        "undotree.persistenceMode": "auto",
        "undotree.autosaveInterval": 5,
        "undotree.excludePatterns": ["ignored*"],
        "update.mode": "none",
      }, null, 2),
      "utf8"
    );

    await fs.writeFile(aPath, "# A\nline a\n", "utf8");
    await fs.writeFile(
      bPath,
      Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
      "utf8"
    );
    await fs.writeFile(path.join(workspaceDir, "ignored.md"), "ignored\n", "utf8");

    if (vsixPath) {
      await fs.access(vsixPath);
      const installArgs = [
        "--install-extension",
        vsixPath,
        "--force",
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
      ];
      if (process.platform === "win32") {
        const cliScript = await findVsCodeCliScript(vscodePath);
        await execFileAsync(vscodePath, [cliScript, ...installArgs], {
          windowsHide: true,
          timeout: 120_000,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            VSCODE_DEV: "",
          },
        });
      } else {
        await execFileAsync(vscodePath, installArgs, { timeout: 120_000 });
      }
    }

    let launched = await launchVsCode(vscodePath, repo, workspaceDir, userDataDir, extensionsDir, !!vsixPath);
    app = launched.app;
    let page = launched.page;

    await openFile(page, "a.md");
    await appendAndSave(page, "\nline a2");
    await appendAndSave(page, "\nline a3");

    await runCase("history is rendered for the active file", async () => {
      const frame = await showUndoTree(page);
      const text = await frame.locator("body").innerText();
      assert.match(text, /5 L/);
      assert.ok(await frame.locator(".node").count() >= 3, "expected at least three history nodes");
    });

    await runCase("Undo and Redo mutate the source document", async () => {
      let frame = await getUndoTreeFrame(page);
      await frame.locator("#btn-undo").click();
      await page.waitForTimeout(1000);
      await page.keyboard.press("Control+S");
      await waitForFileText(aPath, (content) => content.includes("line a2") && !content.includes("line a3"), "Undo to reach the previous save");

      frame = await getUndoTreeFrame(page);
      await frame.locator("#btn-redo").click();
      await page.waitForTimeout(1000);
      await page.keyboard.press("Control+S");
      await waitForFileText(aPath, (content) => content.includes("line a3"), "Redo to restore the latest save");
    });

    await runCase("Undo from an active diff editor is routed to the source file", async () => {
      let frame = await getUndoTreeFrame(page);
      await frame.locator("#btn-mode").click();
      await page.waitForTimeout(500);
      frame = await getUndoTreeFrame(page);
      await frame.locator(".node:not(.current)").last().click();
      await page.locator(".monaco-diff-editor").first().waitFor({ state: "visible", timeout: 15_000 });

      frame = await getUndoTreeFrame(page);
      await frame.locator("#btn-undo").click();
      await page.waitForTimeout(1000);
      await openFile(page, "a.md");
      await page.keyboard.press("Control+S");
      await waitForFileText(aPath, (content) => content.includes("line a2") && !content.includes("line a3"), "diff-mode Undo to update a.md");

      frame = await getUndoTreeFrame(page);
      await frame.locator("#btn-redo").click();
      await page.waitForTimeout(1000);
      await page.keyboard.press("Control+S");
      await waitForFileText(aPath, (content) => content.includes("line a3"), "Redo after the diff-mode Undo");
    });

    await runCase("notes are accepted from the webview", async () => {
      const frame = await getUndoTreeFrame(page);
      await frame.locator(".node.current .note-action").click();
      const input = page.locator(".quick-input-widget:visible input").first();
      await input.waitFor({ state: "visible", timeout: 10_000 });
      await input.fill("e2e persisted note");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
      assert.match(await readUndoTreeText(page), /e2e persisted note/);
    });

    await runCase("the collapsed sidebar follows the newly opened file", async () => {
      const textA = await readUndoTreeText(page);
      await toggleUndoTreeView(page);
      await openFile(page, "b.md");
      await page.waitForTimeout(1000);
      await toggleUndoTreeView(page);
      await page.waitForTimeout(1500);
      const textB = await readUndoTreeText(page);
      assert.match(textA, /5 L/);
      assert.match(textB, /21 L/);
      assert.doesNotMatch(textB, /5 L/);
    });

    await runCase("exclude patterns cannot be bypassed from the sidebar", async () => {
      await openFile(page, "ignored.md");
      await showUndoTree(page);
      const frame = await getUndoTreeFrame(page);
      assert.match(await frame.locator("body").innerText(), /excluded by a pattern/i);
      assert.equal(await frame.locator("#legacy-enable-tracking").count(), 0);
    });

    await openFile(page, "a.md");
    await page.waitForTimeout(6000);
    await app.close();
    app = undefined;

    await runCase("history and metadata survive a VS Code restart", async () => {
      launched = await launchVsCode(vscodePath, repo, workspaceDir, userDataDir, extensionsDir, !!vsixPath);
      app = launched.app;
      page = launched.page;
      await openFile(page, "a.md");
      const frame = await showUndoTree(page);
      const text = await frame.locator("body").innerText();
      assert.match(text, /5 L/);
      assert.match(text, /e2e persisted note/);
      assert.ok(await frame.locator(".node").count() >= 3, "expected persisted history nodes after restart");
    });

    console.log(`Playwright E2E passed: 7 release-critical scenarios completed (${vsixPath ? "installed VSIX" : "extension development host"}).`);
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
