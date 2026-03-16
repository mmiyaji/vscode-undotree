const vscode = {
    commands: {
        executeCommand: jest.fn(),
    },
    window: {
        activeTextEditor: undefined as unknown,
    },
};

export = vscode;
