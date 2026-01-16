import * as vscode from 'vscode';
import WebSocket from 'ws';
import { getMcpEnabledStatus, McpEnabledStatus } from './claudeCodeIntegration';

export interface CompileError {
    file: string;
    line: number;
    column: number;
    severity: 'error' | 'warning' | 'note';
    message: string;
}

export interface CompileStatus {
    success: boolean;
    message: string;
    errors?: CompileError[];
}

export interface PendingChange {
    operator: string;
    param: string;
    paramType: string;
    oldValue: number[];
    newValue: number[];
    sourceLine: number;
    timestamp: number;
}

export interface VividState {
    connected: boolean;
    compileStatus: CompileStatus | null;
    operators: any[];
    pendingChanges: PendingChange[];
    projectPath?: string;
}

type StateChangeCallback = (state: VividState) => void;

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private mcpStatusBarItem: vscode.StatusBarItem;
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private mcpCheckTimer: NodeJS.Timeout | null = null;
    private state: VividState = {
        connected: false,
        compileStatus: null,
        operators: [],
        pendingChanges: []
    };
    private mcpStatus: McpEnabledStatus = {
        configured: false,
        enabled: false
    };
    private stateChangeCallbacks: StateChangeCallback[] = [];
    private disposed = false;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;

        // Runtime status bar item (left)
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'vivid.statusBarClick';
        this.updateStatusBar();
        this.statusBarItem.show();

        // MCP status bar item (right of runtime status)
        this.mcpStatusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            99
        );
        this.mcpStatusBarItem.command = 'vivid.mcpStatusBarClick';
        this.updateMcpStatusBar();
        this.mcpStatusBarItem.show();

        // Check MCP status now and when workspace changes
        this.checkMcpStatus();
        vscode.workspace.onDidChangeWorkspaceFolders(() => this.checkMcpStatus());

        // Start connection attempts
        this.connect();
    }

    onStateChange(callback: StateChangeCallback): vscode.Disposable {
        this.stateChangeCallbacks.push(callback);
        // Immediately call with current state
        callback(this.state);
        return {
            dispose: () => {
                const index = this.stateChangeCallbacks.indexOf(callback);
                if (index > -1) {
                    this.stateChangeCallbacks.splice(index, 1);
                }
            }
        };
    }

    getState(): VividState {
        return this.state;
    }

    private notifyStateChange() {
        for (const callback of this.stateChangeCallbacks) {
            callback(this.state);
        }
    }

    private connect() {
        if (this.disposed) return;

        try {
            this.ws = new WebSocket('ws://127.0.0.1:9876');

            this.ws.on('open', () => {
                this.outputChannel.appendLine('[StatusBar] Connected to Vivid');
                this.state.connected = true;
                this.updateStatusBar();
                this.notifyStateChange();

                // Request initial state
                this.send({ type: 'request_operators' });
                this.send({ type: 'request_compile_status' });
                this.send({ type: 'request_pending_changes' });
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (e) {
                    this.outputChannel.appendLine(`[StatusBar] Failed to parse message: ${e}`);
                }
            });

            this.ws.on('close', () => {
                this.outputChannel.appendLine('[StatusBar] Disconnected from Vivid');
                this.state.connected = false;
                this.state.compileStatus = null;
                this.state.operators = [];
                this.state.pendingChanges = [];
                this.updateStatusBar();
                this.notifyStateChange();
                this.scheduleReconnect();
            });

            this.ws.on('error', (err) => {
                // Don't log connection refused errors (expected when Vivid not running)
                if (!err.message.includes('ECONNREFUSED')) {
                    this.outputChannel.appendLine(`[StatusBar] WebSocket error: ${err.message}`);
                }
                this.ws?.close();
            });
        } catch (e) {
            this.scheduleReconnect();
        }
    }

    private send(message: object) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private handleMessage(message: any) {
        switch (message.type) {
            case 'compile_status':
                this.state.compileStatus = {
                    success: message.success,
                    message: message.message || '',
                    errors: this.parseCompileErrors(message.message)
                };
                this.updateStatusBar();
                this.notifyStateChange();
                break;

            case 'operator_list':
                this.state.operators = message.operators || [];
                this.notifyStateChange();
                break;

            case 'pending_changes':
                this.state.pendingChanges = (message.changes || []).map((c: any) => ({
                    operator: c.operator,
                    param: c.param,
                    paramType: c.paramType,
                    oldValue: c.oldValue || [0, 0, 0, 0],
                    newValue: c.newValue || [0, 0, 0, 0],
                    sourceLine: c.sourceLine || 0,
                    timestamp: c.timestamp || 0
                }));
                this.notifyStateChange();
                break;

            case 'param_values':
                // Could be used for other features
                break;
        }
    }

    // Send commit_changes to Vivid (after applying changes to code)
    sendCommitChanges() {
        this.send({ type: 'commit_changes' });
    }

    // Send discard_changes to Vivid (revert to original values)
    sendDiscardChanges() {
        this.send({ type: 'discard_changes' });
    }

    private parseCompileErrors(message: string): CompileError[] {
        if (!message) return [];

        const errors: CompileError[] = [];
        // Parse GCC/Clang style errors: file:line:column: severity: message
        const regex = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/gm;
        let match;

        while ((match = regex.exec(message)) !== null) {
            errors.push({
                file: match[1],
                line: parseInt(match[2], 10),
                column: parseInt(match[3], 10),
                severity: match[4] as 'error' | 'warning' | 'note',
                message: match[5]
            });
        }

        return errors;
    }

    private scheduleReconnect() {
        if (this.disposed) return;
        if (this.reconnectTimer) return;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 3000); // Retry every 3 seconds
    }

    private updateStatusBar() {
        if (this.state.connected) {
            if (this.state.compileStatus?.success === false) {
                this.statusBarItem.text = '$(error) Vivid: Compile Error';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                this.statusBarItem.tooltip = 'Click to see compile errors';
            } else {
                this.statusBarItem.text = '$(play) Vivid: Running';
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = `Connected to Vivid (${this.state.operators.length} operators)`;
            }
        } else {
            this.statusBarItem.text = '$(circle-slash) Vivid: Not Running';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'Click to run a project';
        }
    }

    private async checkMcpStatus() {
        if (this.disposed) return;

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.mcpStatus = await getMcpEnabledStatus(workspacePath);
        this.updateMcpStatusBar();

        // Log status for debugging
        if (!this.mcpStatus.enabled && this.mcpStatus.disabledReason) {
            this.outputChannel.appendLine(`[MCP Status] ${this.mcpStatus.disabledReason}`);
        }
    }

    private updateMcpStatusBar() {
        if (!this.mcpStatus.configured) {
            // MCP not configured at all
            this.mcpStatusBarItem.text = '$(debug-disconnect) MCP';
            this.mcpStatusBarItem.backgroundColor = undefined;
            this.mcpStatusBarItem.tooltip = 'Vivid MCP not configured - Click to set up';
        } else if (!this.mcpStatus.enabled) {
            // MCP configured but disabled for this project
            this.mcpStatusBarItem.text = '$(warning) MCP';
            this.mcpStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.mcpStatusBarItem.tooltip = `MCP disabled: ${this.mcpStatus.disabledReason}\nClick to enable`;
        } else {
            // MCP configured and enabled
            this.mcpStatusBarItem.text = '$(link) MCP';
            this.mcpStatusBarItem.backgroundColor = undefined;
            this.mcpStatusBarItem.tooltip = 'Vivid MCP enabled for Claude Code';
        }
    }

    async handleMcpStatusBarClick() {
        if (!this.mcpStatus.configured) {
            // Offer to configure
            const action = await vscode.window.showInformationMessage(
                'Vivid MCP is not configured for Claude Code.',
                'Configure Now',
                'Learn More'
            );
            if (action === 'Configure Now') {
                vscode.commands.executeCommand('vivid.configureClaudeCode');
            } else if (action === 'Learn More') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/anthropics/claude-code'));
            }
        } else if (!this.mcpStatus.enabled) {
            // Show warning about disabled state
            const action = await vscode.window.showWarningMessage(
                `Vivid MCP is disabled for this project.\n${this.mcpStatus.disabledReason}`,
                'Open Claude Config',
                'Run /mcp in Claude Code'
            );
            if (action === 'Open Claude Config') {
                const configPath = require('path').join(require('os').homedir(), '.claude.json');
                const doc = await vscode.workspace.openTextDocument(configPath);
                await vscode.window.showTextDocument(doc);
            } else if (action === 'Run /mcp in Claude Code') {
                vscode.window.showInformationMessage(
                    'In Claude Code, type /mcp to manage MCP server settings for this project.'
                );
            }
        } else {
            // Show status
            vscode.window.showInformationMessage('Vivid MCP is configured and enabled for Claude Code.');
        }
    }

    async handleStatusBarClick() {
        if (this.state.connected) {
            if (this.state.compileStatus?.success === false) {
                // Show compile error
                const message = this.state.compileStatus.message || 'Unknown compile error';
                const action = await vscode.window.showErrorMessage(
                    'Vivid Compile Error',
                    { modal: false, detail: message },
                    'Show Problems'
                );
                if (action === 'Show Problems') {
                    vscode.commands.executeCommand('workbench.actions.view.problems');
                }
            } else {
                // Show running status
                vscode.window.showInformationMessage(
                    `Vivid is running with ${this.state.operators.length} operators`
                );
            }
        } else {
            // Run project directly with --show-ui (quick mode)
            vscode.commands.executeCommand('vivid.runProject', { quick: true });
        }
    }

    dispose() {
        this.disposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        if (this.mcpCheckTimer) {
            clearTimeout(this.mcpCheckTimer);
        }
        if (this.ws) {
            this.ws.close();
        }
        this.statusBarItem.dispose();
        this.mcpStatusBarItem.dispose();
    }
}
