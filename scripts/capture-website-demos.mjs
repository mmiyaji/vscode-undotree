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
  const language = process.argv[2] || "en";
  let app;

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(userDataDir, "User"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "User", "settings.json"), JSON.stringify({ "undotree.language": language, "undotree.autosaveInterval": 0 }));
    await fs.mkdir(extensionsDir, { recursive: true });

    const demoPath = path.join(workspaceDir, "products.ts");
    await fs.writeFile(demoPath, [
      "type Product = { name: string; price: number; stock: number };",
      "",
      "const products: Product[] = [",
      "  { name: 'Notebook', price: 980, stock: 5 },",
      "  { name: 'Pen', price: 240, stock: 0 },",
      "  { name: 'Pencil', price: 120, stock: 12 },",
      "];",
      "",
      "export function productCards() {",
      "  return products.map(product => product.name);",
      "}",
      ""
    ].join("\n"), "utf8");
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
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(8000);

    await runCommand(page, "View: Close Secondary Side Bar");
    await runCommand(page, "View: Close Panel");
    await runCommand(page, "View: Appearance: Hide Status Bar");
    await runCommand(page, "View: Appearance: Hide Activity Bar");
    await openFile(page, "products.ts");
    await page.waitForTimeout(1200);

    await page.keyboard.press("Control+End");
    await appendAndSave(page, "\n// Only show products that are in stock.");
    await appendAndSave(page, "\nconst available = products.filter(product => product.stock > 0);");
    await appendAndSave(page, "\nconst byPrice = available.sort((a, b) => a.price - b.price);");
    await appendAndSave(page, "\nconst yen = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' });");
    await page.keyboard.press("Control+Shift+U");
    await page.waitForTimeout(1800);
    const frame = await waitForUndoTreeFrame(page);
    const sash = page.locator('.monaco-sash.horizontal').filter({ visible: true });
    const handles = await sash.all();
    const positions = await Promise.all(handles.map(async handle => ({ handle, box: await handle.boundingBox() })));
    const candidate = positions.filter(item => item.box && item.box.x < 20 && item.box.width < 300 && item.box.y > 200).sort((a, b) => b.box.y - a.box.y)[0];
    if (!candidate) throw new Error('Sidebar resize handle not found');
    await page.mouse.move(candidate.box.x + candidate.box.width / 2, candidate.box.y + 2);
    await page.mouse.down();
    await page.mouse.move(candidate.box.x + candidate.box.width / 2, 260, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const out = path.join(repo, 'website', 'public', 'assets');
    const suffix = language === 'en' ? '-en' : '';
    await frame.locator('.node.current .note-action').click();
    const input = page.locator('.quick-input-widget:visible input').first();
    await input.waitFor({ state: 'visible' });
    await input.fill(language === 'ja' ? '在庫・価格順・円表示を追加' : 'Stock, price & JPY');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await frame.locator('.node.current').click({ button: 'right' });
    await frame.locator('[data-action="toggle-pin"]').click();
    await page.waitForTimeout(800);
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+Home');
    await runCommand(page, 'View: Close Panel');
    await page.screenshot({ path: path.join(out, `products-pins${suffix}.jpg`), type: 'jpeg', quality: 90 });
    await frame.locator('#btn-mode').click();
    await page.waitForTimeout(500);
    await frame.locator('.node:not(.current)').first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, `products-diff${suffix}.jpg`), type: 'jpeg', quality: 90 });
    console.log(`Saved ${language} screenshots`);
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
