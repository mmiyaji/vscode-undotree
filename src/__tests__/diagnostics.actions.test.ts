jest.mock('vscode');

describe('diagnostics failure simulation confirmation', () => {
    const vscode = require('vscode');
    const extension = require('../extension') as typeof import('../extension');

    beforeEach(() => vscode.window.showWarningMessage.mockReset());

    it('requires explicit modal confirmation before modifying the persisted manifest', async () => {
        vscode.window.showWarningMessage.mockResolvedValue('Run simulation');
        expect(await extension.__test__.confirmDiagnosticsSimulation()).toBe(true);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('modifies the saved history manifest'), { modal: true }, 'Run simulation'
        );
    });

    it('does not authorize a simulation when the dialog is dismissed', async () => {
        vscode.window.showWarningMessage.mockResolvedValue(undefined);
        expect(await extension.__test__.confirmDiagnosticsSimulation()).toBe(false);
    });

    it('requires explicit consent to deleting shared history and states that files are unchanged', async () => {
        vscode.window.showWarningMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce('Delete all history');
        expect(await extension.__test__.confirmHistoryReset()).toBe(false);
        expect(await extension.__test__.confirmHistoryReset()).toBe(true);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('shared extension storage across workspaces? Current file contents will not change.'),
            { modal: true }, 'Delete all history'
        );
    });
});
