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
};

export = vscode;
