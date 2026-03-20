import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type RuntimeLanguage = 'auto' | 'en' | 'ja';

let jaBundle: Record<string, string> = {};
let initialized = false;

function formatTemplate(template: string, args: Array<string | number | boolean>): string {
    return template.replace(/\{(\d+)\}/g, (match, indexText) => {
        const index = Number(indexText);
        return index >= 0 && index < args.length ? String(args[index]) : match;
    });
}

function getConfiguredLanguage(): RuntimeLanguage {
    const value = vscode.workspace.getConfiguration('undotree').get<string>('language', 'auto');
    return value === 'en' || value === 'ja' ? value : 'auto';
}

function getEffectiveLanguage(): Exclude<RuntimeLanguage, 'auto'> {
    const configured = getConfiguredLanguage();
    if (configured !== 'auto') {
        return configured;
    }
    return (vscode.env.language ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function initializeRuntimeL10n(context: vscode.ExtensionContext): void {
    if (initialized) {
        return;
    }

    initialized = true;
    try {
        const jaBundlePath = path.join(context.extensionUri.fsPath, 'l10n', 'bundle.l10n.ja.json');
        jaBundle = JSON.parse(fs.readFileSync(jaBundlePath, 'utf8')) as Record<string, string>;
    } catch {
        jaBundle = {};
    }
}

export function t(message: string, ...args: Array<string | number | boolean>): string {
    const effectiveLanguage = getEffectiveLanguage();
    const template = effectiveLanguage === 'ja' ? (jaBundle[message] ?? message) : message;
    return formatTemplate(template, args);
}
