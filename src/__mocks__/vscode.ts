const vscode = {
    commands: {
        executeCommand: jest.fn(),
    },
    Range: class Range {
        constructor(
            public start: unknown,
            public end: unknown
        ) {}
    },
    window: {
        activeTextEditor: undefined as unknown,
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn(),
        })),
    },
    env: {
        language: 'en',
    },
    l10n: {
        t: (message: string, ...args: Array<string | number | boolean>) => {
            // テスト用：プレースホルダーを引数で置換
            return message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
        },
    },
};

export = vscode;
