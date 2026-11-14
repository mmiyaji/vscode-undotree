import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'undotree-tracking-'));
const workspace = path.join(root, 'workspace');
const otherWorkspace = path.join(root, 'other-workspace');
const workspaceFile = path.join(root, 'tracking.code-workspace');
const userData = path.join(root, 'user-data');
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(otherWorkspace, { recursive: true });
await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: otherWorkspace }] }));
await fs.mkdir(path.join(userData, 'User'), { recursive: true });
await fs.mkdir(path.join(root, 'extensions'), { recursive: true });
await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'undotree.persistenceMode': 'manual',
    'undotree.autosaveInterval': 0,
    'undotree.language': 'en',
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
}));
const executable = process.env.VSCODE_E2E_PATH || path.join(
    process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'
);
const env = { ...process.env, UNDOTREE_TRACKING_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`VS Code tracking test artifacts: ${root}`);
const log = createWriteStream(path.join(root, 'vscode.log'));
const child = spawn(executable, [
    workspaceFile, '--new-window', '--user-data-dir', userData,
    '--extensions-dir', path.join(root, 'extensions'), '--skip-welcome',
    '--skip-release-notes', '--disable-workspace-trust',
    `--extensionDevelopmentPath=${repo}`,
    `--extensionTestsPath=${path.join(repo, 'scripts', 'vscode-tracking-tests.cjs')}`,
], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const timeout = setTimeout(() => {
    console.error('VS Code tracking tests exceeded 3 minutes.');
    child.kill();
}, 180_000);
try {
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code ?? 1));
    });
    const report = JSON.parse(await fs.readFile(path.join(root, 'results.json'), 'utf8'));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = code || (report.some(result => !result.passed) ? 1 : 0);
} finally {
    clearTimeout(timeout);
    log.end();
}
