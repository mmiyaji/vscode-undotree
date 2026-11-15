jest.mock('vscode');

describe('persistence mode action', () => {
    const vscode = require('vscode');
    const extension = require('../extension') as typeof import('../extension');
    const update = jest.fn(async () => {});

    beforeEach(() => {
        update.mockClear();
        vscode.window.showQuickPick.mockReset();
        vscode.workspace.getConfiguration.mockReturnValue({
            get: (key: string) => key === 'persistenceMode' ? 'auto' : undefined,
            inspect: () => ({}), update,
        });
    });

    it('updates the existing workspace override instead of writing a shadowed global value', async () => {
        vscode.workspace.getConfiguration.mockReturnValue({
            get: () => 'auto', inspect: () => ({ workspaceValue: 'auto' }), update,
        });
        vscode.window.showQuickPick.mockResolvedValue({ mode: 'manual' });
        await extension.__test__.choosePersistenceMode();
        expect(update).toHaveBeenCalledWith('persistenceMode', 'manual', vscode.ConfigurationTarget.Workspace);
    });

    it('uses user settings when there is no workspace override', async () => {
        vscode.window.showQuickPick.mockResolvedValue({ mode: 'manual' });
        await extension.__test__.choosePersistenceMode();
        expect(update).toHaveBeenCalledWith('persistenceMode', 'manual', vscode.ConfigurationTarget.Global);
    });

    it('leaves settings unchanged on cancellation or when selecting the current mode', async () => {
        vscode.window.showQuickPick.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ mode: 'auto' });
        await extension.__test__.choosePersistenceMode();
        await extension.__test__.choosePersistenceMode();
        expect(update).not.toHaveBeenCalled();
    });
});
