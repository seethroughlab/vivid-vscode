import * as vscode from 'vscode';

export class StatusBar implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private connected: boolean = false;
    private compileSuccess: boolean = true;
    private devMode: boolean = false;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'vivid.startRuntime';
        this.update();
        this.statusBarItem.show();
    }

    setConnected(connected: boolean) {
        this.connected = connected;
        this.update();
    }

    setCompileStatus(success: boolean) {
        this.compileSuccess = success;
        this.update();
    }

    setDevMode(devMode: boolean) {
        this.devMode = devMode;
        this.update();
    }

    private update() {
        const suffix = this.devMode ? ' (dev)' : '';
        if (!this.connected) {
            this.statusBarItem.text = `$(debug-disconnect) Vivid${suffix}`;
            this.statusBarItem.tooltip = this.devMode
                ? 'Using local development runtime - click to start'
                : 'Not connected to runtime - click to start';
            this.statusBarItem.backgroundColor = undefined;
        } else if (!this.compileSuccess) {
            this.statusBarItem.text = `$(error) Vivid${suffix}`;
            this.statusBarItem.tooltip = 'Compile error';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            this.statusBarItem.text = `$(pulse) Vivid${suffix}`;
            this.statusBarItem.tooltip = this.devMode
                ? 'Connected to local development runtime'
                : 'Connected to runtime';
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    dispose() {
        this.statusBarItem.dispose();
    }
}
