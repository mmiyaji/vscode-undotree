const vscode = {
    commands: {
        executeCommand: jest.fn(),
    },
    EventEmitter: class EventEmitter<T> {
        private listeners: Array<(value: T) => void> = [];
        event = (listener: (value: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => {
                this.listeners = this.listeners.filter((l) => l !== listener);
            } };
        };
        fire(value: T) {
            for (const listener of this.listeners) {
                listener(value);
            }
        }
    },
    Uri: {
        parse: (value: string) => ({
            toString: () => value,
            path: value.replace(/^[^:]+:/, ''),
        }),
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
