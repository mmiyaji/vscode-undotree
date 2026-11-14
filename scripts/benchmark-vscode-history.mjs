import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = process.argv[2];
if (!fixtures) { throw new Error('Pass the artifact directory from benchmark-history.cjs'); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'undotree-native-perf-'));
await fs.mkdir(path.join(root, 'user-data', 'User'), { recursive: true });
await fs.mkdir(path.join(root, 'extensions'), { recursive: true });
await fs.writeFile(path.join(root, 'user-data', 'User', 'settings.json'), JSON.stringify({
    'undotree.persistenceMode': 'manual', 'undotree.autosaveInterval': 0,
    'undotree.language': 'en', 'undotree.showStorageKind': true,
    'workbench.startupEditor': 'none', 'workbench.editor.largeFileOptimizations': true,
    'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
}));
const env = { ...process.env, UNDOTREE_PERF_ROOT: root, UNDOTREE_PERF_FIXTURES: path.resolve(fixtures) };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.VSCODE_E2E_PATH || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const log = createWriteStream(path.join(root, 'vscode.log'));
const child = spawn(executable, [
    '--new-window', '--user-data-dir', path.join(root, 'user-data'), '--extensions-dir', path.join(root, 'extensions'),
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    `--extensionDevelopmentPath=${repo}`, `--extensionTestsPath=${path.join(repo, 'scripts', 'vscode-performance-tests.cjs')}`,
], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
console.log(`Native VS Code performance artifacts: ${root}`);
const timeout = setTimeout(() => { console.error('Native benchmark timed out'); child.kill(); }, 240_000);
try {
    process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', code => resolve(code ?? 1));
    });
    try {
        console.log(await fs.readFile(path.join(root, 'metrics.json'), 'utf8'));
    } catch {
        process.exitCode = 1;
        console.error(`VS Code stopped before producing measurements. See ${path.join(root, 'vscode.log')}`);
    }
} finally { clearTimeout(timeout); log.end(); }
