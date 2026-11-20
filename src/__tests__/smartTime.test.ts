import { UndoTreeManager } from '../undoTreeManager';
import { UndoTreeProvider } from '../undoTreeProvider';
jest.mock('vscode');
jest.useFakeTimers();

describe('smart history timestamps', () => {
    const manager = new UndoTreeManager();
    const provider = new UndoTreeProvider({} as any, manager) as any;
    afterAll(() => manager.dispose());
    const stamp = (date: Date) => provider.createTimestampFormatter('smart', '')(date.getTime());
    beforeEach(() => jest.setSystemTime(new Date(2026, 10, 15, 0, 5)));

    it('shows only hours and minutes today, and a day indicator yesterday', () => {
        expect(stamp(new Date(2026, 10, 15, 0, 2, 45))).toBe('00:02');
        expect(stamp(new Date(2026, 10, 14, 23, 59))).toBe('Yesterday 23:59');
    });
    it('shows a compact date for older edits and the year for past years', () => {
        expect(stamp(new Date(2026, 10, 13, 14, 32))).toBe('11/13 14:32');
        expect(stamp(new Date(2025, 10, 13, 14, 32))).toBe('2025/11/13');
    });
    it('treats the previous calendar day as yesterday across a year boundary', () => {
        jest.setSystemTime(new Date(2027, 0, 1, 0, 1));
        expect(stamp(new Date(2026, 11, 31, 23, 59))).toBe('Yesterday 23:59');
    });
    it('defaults to smart while preserving an explicit time-only preference', () => {
        const vscode = require('vscode');
        vscode.workspace.getConfiguration.mockReturnValue({ get: () => undefined });
        expect(provider.getTimeFormat()).toBe('smart');
        vscode.workspace.getConfiguration.mockReturnValue({ get: () => 'time' });
        expect(provider.getTimeFormat()).toBe('time');
        const sections = require('../../package.json').contributes.configuration;
        expect(sections.find((s: any) => s.properties['undotree.timeFormat']).properties['undotree.timeFormat'].default).toBe('smart');
    });
});
