import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { RuntimeClient, NodeUpdate, SoloState } from './runtimeClient';
import { DecorationManager } from './decorations';
import { StatusBar } from './statusBar';
import { OperatorTreeProvider, ParamData, OperatorData } from './operatorTreeView';
import { PerformancePanelProvider } from './performancePanel';
import { NodeInspectorPanel } from './nodeInspectorPanel';
import { ChainCodeSync } from './chainCodeSync';
import { RuntimeManager } from './runtimeManager';
import { ChildProcess, spawn } from 'child_process';
import { checkAndPromptMcpConfiguration } from './mcpConfigChecker';
import { OperatorCatalog } from './operatorCatalog';
import { OperatorLibraryPanel } from './operatorLibraryPanel';
import { OperatorDropProvider } from './operatorDropProvider';
import { AddonManager, showAddonManager } from './addonManager';
import * as os from 'os';

// File for sharing runtime status with MCP server
const RUNTIME_STATUS_FILE = path.join(os.homedir(), '.vivid', 'runtime-status.json');

interface RuntimeStatus {
    connected: boolean;
    lastError: string | null;
    lastErrorTime: string | null;
    compileSuccess: boolean | null;
    compileError: string | null;
    compileErrorTime: string | null;
}

function writeRuntimeStatus(status: Partial<RuntimeStatus>) {
    try {
        let current: RuntimeStatus = {
            connected: false,
            lastError: null,
            lastErrorTime: null,
            compileSuccess: null,
            compileError: null,
            compileErrorTime: null
        };

        // Read existing status
        if (fs.existsSync(RUNTIME_STATUS_FILE)) {
            current = JSON.parse(fs.readFileSync(RUNTIME_STATUS_FILE, 'utf8'));
        }

        // Merge updates
        const updated = { ...current, ...status };

        // Ensure directory exists
        const dir = path.dirname(RUNTIME_STATUS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(RUNTIME_STATUS_FILE, JSON.stringify(updated, null, 2));
    } catch (e) {
        // Ignore errors writing status
    }
}

let runtimeClient: RuntimeClient | undefined;
let runtimeManager: RuntimeManager | undefined;
let runtimeProcess: ChildProcess | undefined;
let hookServer: http.Server | undefined;
let decorationManager: DecorationManager | undefined;
let statusBar: StatusBar | undefined;
let operatorTreeProvider: OperatorTreeProvider | undefined;
let performancePanelProvider: PerformancePanelProvider | undefined;
let nodeInspectorPanel: NodeInspectorPanel | undefined;
let chainCodeSync: ChainCodeSync | undefined;
let operatorCatalog: OperatorCatalog | undefined;
let operatorLibraryPanel: OperatorLibraryPanel | undefined;
let addonManager: AddonManager | undefined;
let outputChannel: vscode.OutputChannel;
let diagnosticCollection: vscode.DiagnosticCollection;

// Track current operators and params for inspector
let currentOperators: OperatorData[] = [];
let currentParams: ParamData[] = [];

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Vivid');
    outputChannel.appendLine('Vivid extension activated');

    // Initialize runtime manager for download-on-demand
    runtimeManager = new RuntimeManager(outputChannel);
    runtimeManager.setExtensionPath(context.extensionPath);
    // Install MCP server (if not already installed or needs update)
    runtimeManager.installMcpServer();

    // Create diagnostic collection for compile errors
    diagnosticCollection = vscode.languages.createDiagnosticCollection('vivid');
    context.subscriptions.push(diagnosticCollection);

    decorationManager = new DecorationManager(context);
    statusBar = new StatusBar();

    // Register operator tree view
    operatorTreeProvider = new OperatorTreeProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('vividOperators', operatorTreeProvider)
    );

    // Register performance panel
    performancePanelProvider = new PerformancePanelProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PerformancePanelProvider.viewType,
            performancePanelProvider
        )
    );

    // Register node inspector panel
    nodeInspectorPanel = new NodeInspectorPanel(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            NodeInspectorPanel.viewType,
            nodeInspectorPanel
        )
    );

    // Initialize chain code sync with extension path for Tree-sitter
    chainCodeSync = new ChainCodeSync();
    chainCodeSync.setExtensionPath(context.extensionPath);
    chainCodeSync.setOutputChannel(outputChannel);

    // Initialize operator catalog for browsing available operators
    operatorCatalog = new OperatorCatalog();
    operatorCatalog.setOutputChannel(outputChannel);

    // Initialize addon manager for installing/removing addons
    addonManager = new AddonManager(outputChannel);

    // Register operator library panel
    operatorLibraryPanel = new OperatorLibraryPanel(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            OperatorLibraryPanel.viewType,
            operatorLibraryPanel
        )
    );

    // Wire up library panel callback
    operatorLibraryPanel.onOperatorSelected(async (operator) => {
        // Insert the operator at current cursor position
        if (!chainCodeSync) return;

        const editor = vscode.window.activeTextEditor;
        let afterLine = -1;
        let previousOperatorVar: string | undefined;

        if (editor && editor.document.fileName.endsWith('chain.cpp')) {
            const cursorLine = editor.selection.active.line + 1;
            const operatorAtCursor = findOperatorAtLine(cursorLine);
            if (operatorAtCursor) {
                afterLine = operatorAtCursor.sourceLine;
                previousOperatorVar = chainCodeSync.getOperatorVariable(operatorAtCursor.name);
            }
        }

        const result = await chainCodeSync.insertOperator(operator, afterLine, previousOperatorVar);
        if (result) {
            outputChannel.appendLine(`Added operator ${operator.name} as "${result.variableName}" at line ${result.line}`);

            const files = await vscode.workspace.findFiles('**/chain.cpp', null, 1);
            if (files.length > 0) {
                const doc = await vscode.workspace.openTextDocument(files[0]);
                const editor = await vscode.window.showTextDocument(doc);
                const position = new vscode.Position(result.line - 1, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }

            if (runtimeClient) {
                setTimeout(() => runtimeClient?.sendReload(), 500);
            }

            vscode.window.setStatusBarMessage(`$(check) Added ${operator.name}`, 3000);
        }
    });

    // Register document drop provider for drag-and-drop from library
    const dropProvider = new OperatorDropProvider();
    dropProvider.setCatalog(operatorCatalog);
    dropProvider.setChainCodeSync(chainCodeSync);
    dropProvider.setOutputChannel(outputChannel);

    context.subscriptions.push(
        vscode.languages.registerDocumentDropEditProvider(
            { language: 'cpp', pattern: '**/chain.cpp' },
            dropProvider,
            {
                dropMimeTypes: ['application/vnd.vivid.operator', 'text/plain']
            }
        )
    );

    // Wire up inspector callbacks
    nodeInspectorPanel.onParamChange((operator, param, value) => {
        if (runtimeClient) {
            runtimeClient.sendParamChange(operator, param, value);

            // Also sync to source code (debounced)
            const paramInfo = currentParams.find(p => p.operator === operator && p.name === param);
            if (paramInfo && chainCodeSync) {
                outputChannel.appendLine(`Code sync: ${operator}.${param} type=${paramInfo.type}`);
                chainCodeSync.scheduleParamUpdate(operator, param, value, paramInfo.type);
            } else {
                outputChannel.appendLine(`Code sync: param not found for ${operator}.${param} (have ${currentParams.length} params)`);
            }

            outputChannel.appendLine(`Inspector: ${operator}.${param} = [${value.join(', ')}]`);
        }
    });

    nodeInspectorPanel.onSoloRequest((operator) => {
        soloOperator(operator);
    });

    nodeInspectorPanel.onExitSoloRequest(() => {
        exitSolo();
    });

    nodeInspectorPanel.onBrowseFile(async (operator, param, filter, category) => {
        // Convert filter format (*.png;*.jpg) to VS Code filter format
        const filters: { [key: string]: string[] } = {};
        const categoryName = category || 'Files';

        // Parse filter string
        const extensions = filter.split(';').map(f => f.replace('*.', '').trim());
        filters[categoryName] = extensions;

        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: filters,
            title: `Select ${param}`
        });

        if (result && result.length > 0) {
            const filePath = result[0].fsPath;
            // TODO: Send string param change to runtime
            // For now, just log it - runtime needs to support string params
            outputChannel.appendLine(`File selected: ${operator}.${param} = ${filePath}`);
        }
    });

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vivid.startRuntime', () => startRuntime(context)),
        vscode.commands.registerCommand('vivid.stopRuntime', stopRuntime),
        vscode.commands.registerCommand('vivid.reload', reload),
        vscode.commands.registerCommand('vivid.toggleInlineDecorations', toggleInlineDecorations),
        vscode.commands.registerCommand('vivid.goToOperator', goToOperator),
        vscode.commands.registerCommand('vivid.editParam', editParam),
        vscode.commands.registerCommand('vivid.refreshOperators', () => {
            // Request fresh operator list from runtime
            if (runtimeClient) {
                runtimeClient.sendReload();
            }
        }),
        vscode.commands.registerCommand('vivid.soloOperator', soloOperator),
        vscode.commands.registerCommand('vivid.exitSolo', exitSolo),
        vscode.commands.registerCommand('vivid.inspectOperator', inspectOperator),
        vscode.commands.registerCommand('vivid.checkForUpdates', () => runtimeManager?.checkForUpdates()),
        vscode.commands.registerCommand('vivid.reinstallRuntime', () => runtimeManager?.installOrUpdate(true)),
        vscode.commands.registerCommand('vivid.createProject', () => createProject(context)),
        vscode.commands.registerCommand('vivid.configureMcp', async () => {
            const { configureVividMcp, getMcpDocsPath } = await import('./mcpConfigChecker');
            const { installVividHook } = await import('./hookInstaller');

            const mcpSuccess = await configureVividMcp();
            const hookSuccess = await installVividHook();

            if (mcpSuccess && hookSuccess) {
                const docsPath = getMcpDocsPath();
                vscode.window.showInformationMessage(
                    `Vivid MCP and pre-edit hook configured. Docs path: ${docsPath}. Restart Claude Code to apply.`
                );
            } else if (mcpSuccess) {
                vscode.window.showWarningMessage(
                    'Vivid MCP configured but hook installation failed. Pre-edit warnings may not work.'
                );
            } else {
                vscode.window.showErrorMessage('Failed to configure Vivid MCP server.');
            }
        }),
        vscode.commands.registerCommand('vivid.addOperator', () => addOperator()),
        vscode.commands.registerCommand('vivid.refreshOperatorLibrary', () => refreshOperatorLibrary()),
        vscode.commands.registerCommand('vivid.manageAddons', () => manageAddons()),
        vscode.commands.registerCommand('vivid.bundleProject', () => bundleProject())
    );

    // Watch for editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && decorationManager) {
                decorationManager.updateDecorations(editor);
            }
        })
    );

    // Watch for changes to chain.cpp to invalidate cached locations
    // This prevents conflicts when external tools (like Claude CLI) edit the file
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.fileName.endsWith('chain.cpp')) {
                chainCodeSync?.onDocumentChanged();
            }
        })
    );

    // Clear pending change decorations when chain.cpp is saved
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.fileName.endsWith('chain.cpp')) {
                chainCodeSync?.clearPendingDecorations();
            }
        })
    );

    // Watch for external file changes (e.g., Claude Code edits)
    // Auto-reload clean buffers, prompt for dirty buffers
    const chainFileWatcher = vscode.workspace.createFileSystemWatcher('**/chain.cpp');
    chainFileWatcher.onDidChange(async (uri) => {
        const document = vscode.workspace.textDocuments.find(
            doc => doc.uri.fsPath === uri.fsPath
        );

        if (document) {
            if (document.isDirty) {
                // Buffer has unsaved changes - prompt user
                const choice = await vscode.window.showWarningMessage(
                    `"${path.basename(uri.fsPath)}" was modified externally. Reload to see changes?`,
                    'Reload',
                    'Ignore'
                );

                if (choice === 'Reload') {
                    await vscode.commands.executeCommand('workbench.action.files.revert', uri);
                    chainCodeSync?.onDocumentChanged();
                }
            } else {
                // Buffer is clean - auto-reload to stay in sync with disk
                await vscode.commands.executeCommand('workbench.action.files.revert', uri);
                chainCodeSync?.onDocumentChanged();
                outputChannel.appendLine('Auto-reloaded chain.cpp after external edit');
            }
        }
    });
    context.subscriptions.push(chainFileWatcher);

    // HTTP server for Claude Code hook integration
    // Allows pre-edit hooks to check if chain.cpp has unsaved changes
    const HOOK_SERVER_PORT = 9877;
    hookServer = http.createServer(async (req, res) => {
        // Only handle POST /prepare-for-edit
        if (req.method === 'POST' && req.url === '/prepare-for-edit') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { file_path } = JSON.parse(body || '{}');

                    // Find dirty chain.cpp documents
                    const dirtyChainDoc = vscode.workspace.textDocuments.find(
                        doc => doc.fileName.endsWith('chain.cpp') && doc.isDirty
                    );

                    // If editing chain.cpp and it has unsaved changes, prompt user
                    if (dirtyChainDoc && file_path && file_path.endsWith('chain.cpp')) {
                        const choice = await vscode.window.showWarningMessage(
                            'chain.cpp has unsaved slider changes. What would you like to do before Claude edits?',
                            'Save Changes',
                            'Discard Changes',
                            'Cancel Edit'
                        );

                        if (choice === 'Save Changes') {
                            await dirtyChainDoc.save();
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ action: 'proceed' }));
                        } else if (choice === 'Discard Changes') {
                            await vscode.commands.executeCommand('workbench.action.files.revert', dirtyChainDoc.uri);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ action: 'proceed' }));
                        } else {
                            // Cancel or dismissed
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ action: 'cancel' }));
                        }
                    } else {
                        // No unsaved changes or not editing chain.cpp
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ action: 'proceed' }));
                    }
                } catch {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ action: 'proceed' }));
                }
            });
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    hookServer.listen(HOOK_SERVER_PORT, '127.0.0.1', () => {
        outputChannel.appendLine(`Hook server listening on http://127.0.0.1:${HOOK_SERVER_PORT}`);
    });

    hookServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            outputChannel.appendLine(`Hook server port ${HOOK_SERVER_PORT} already in use (another VS Code window?)`);
        } else {
            outputChannel.appendLine(`Hook server error: ${err.message}`);
        }
    });

    // Cursor tracking: auto-select operator at cursor position
    // Also sends "focused_node" for 3x larger preview in runtime
    let lastSelectedOperator: string | undefined;
    let lastFocusedOperator: string | undefined;
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(event => {
            const editor = event.textEditor;
            if (!editor || !isVividFile(editor.document)) {
                // Cursor left a Vivid file - clear focus
                if (lastFocusedOperator !== undefined) {
                    lastFocusedOperator = undefined;
                    if (runtimeClient) {
                        runtimeClient.sendFocusedNode('');
                    }
                }
                return;
            }

            const cursorLine = editor.selection.active.line + 1; // 1-indexed
            const operator = findOperatorAtLine(cursorLine);

            // Debug: log when cursor is on a potential operator line
            if (currentOperators.length > 0 && !operator) {
                // Only log occasionally to avoid spam
                const nearestOp = currentOperators.find(op => Math.abs(op.sourceLine - cursorLine) <= 5);
                if (nearestOp) {
                    outputChannel.appendLine(`Cursor at line ${cursorLine}, nearest operator "${nearestOp.name}" at line ${nearestOp.sourceLine}`);
                }
            }

            if (operator && operator.name !== lastSelectedOperator) {
                lastSelectedOperator = operator.name;
                // Update VSCode inspector panel
                inspectOperator(operator.name);
                // Send selection to vivid runtime (highlights node)
                if (runtimeClient) {
                    runtimeClient.sendSelectNode(operator.name);
                }
            }

            // Send focused node for 3x larger preview
            const focusedName = operator?.name ?? '';
            if (focusedName !== lastFocusedOperator) {
                lastFocusedOperator = focusedName || undefined;
                if (runtimeClient) {
                    runtimeClient.sendFocusedNode(focusedName);
                }
            }
        })
    );

    // Auto-start runtime if this is a newly created project or autoConnect is enabled
    const config = vscode.workspace.getConfiguration('vivid');
    const autoStartProject = context.globalState.get<string>('vivid.autoStartProject');
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (autoStartProject && workspacePath && autoStartProject === workspacePath) {
        // This is a newly created project - clear the flag and auto-start
        context.globalState.update('vivid.autoStartProject', undefined);
        // Small delay to let VS Code finish loading
        setTimeout(() => startRuntime(context), 1000);
    } else if (config.get<boolean>('autoConnect')) {
        // Check if this is a Vivid project and auto-start runtime
        // Only check root and src/ - avoids false positives from runtime source templates
        Promise.all([
            vscode.workspace.findFiles('chain.cpp', null, 1),
            vscode.workspace.findFiles('src/chain.cpp', null, 1)
        ]).then(([rootFiles, srcFiles]) => {
            if (rootFiles.length > 0 || srcFiles.length > 0) {
                startRuntime(context);
            }
        });
    }

    // Check for updates on startup if enabled (skip in dev mode)
    const customRuntimePath = config.get<string>('runtimePath');
    if (!customRuntimePath && config.get<boolean>('checkUpdatesOnStart') && runtimeManager?.isInstalled()) {
        // Delay the check slightly to not slow down activation
        setTimeout(() => {
            runtimeManager?.checkForUpdates();
        }, 5000);
    }

    // Check if Claude Code is configured to use Vivid MCP server
    // Delay slightly to not block activation
    setTimeout(() => {
        checkAndPromptMcpConfiguration(outputChannel);
    }, 3000);

    context.subscriptions.push(outputChannel, statusBar);
}

function connectToRuntime() {
    const config = vscode.workspace.getConfiguration('vivid');
    const port = config.get<number>('websocketPort') || 9876;

    outputChannel.appendLine(`Attempting to connect to runtime on port ${port}...`);

    if (runtimeClient) {
        runtimeClient.disconnect();
    }

    runtimeClient = new RuntimeClient(port, outputChannel);

    runtimeClient.onConnected(() => {
        outputChannel.appendLine('Connected to Vivid runtime');
        statusBar?.setConnected(true);
    });

    runtimeClient.onDisconnected(() => {
        outputChannel.appendLine('Disconnected from Vivid runtime');
        statusBar?.setConnected(false);
        operatorTreeProvider?.clear();
        chainCodeSync?.clear();
        currentOperators = [];
        currentParams = [];
        vscode.window.setStatusBarMessage('$(warning) Vivid: Disconnected from runtime', 5000);
    });

    runtimeClient.onNodeUpdate((nodes) => {
        if (decorationManager) {
            decorationManager.updateNodes(nodes);
            const editor = vscode.window.activeTextEditor;
            if (editor && isVividFile(editor.document)) {
                decorationManager.updateDecorations(editor);
            }
        }
    });

    runtimeClient.onCompileStatus((success, message) => {
        if (success) {
            vscode.window.setStatusBarMessage('$(check) Vivid: Compiled', 3000);
            outputChannel.appendLine('Compilation successful');
            diagnosticCollection.clear();
            writeRuntimeStatus({
                compileSuccess: true,
                compileError: null,
                compileErrorTime: null
            });
        } else {
            vscode.window.showErrorMessage(`Vivid compile error: ${message}`);
            outputChannel.appendLine(`Compile error: ${message}`);
            showCompileErrors(message);
            writeRuntimeStatus({
                compileSuccess: false,
                compileError: message,
                compileErrorTime: new Date().toISOString()
            });
        }
        statusBar?.setCompileStatus(success);
    });

    runtimeClient.onOperatorList((operators) => {
        outputChannel.appendLine(`Received ${operators.length} operators:`);
        for (const op of operators) {
            outputChannel.appendLine(`  - "${op.name}" (${op.displayName}) at line ${op.sourceLine}`);
        }
        currentOperators = operators;
        operatorTreeProvider?.updateOperators(operators);
        decorationManager?.updateOperators(operators);

        // Parse chain file for code sync
        chainCodeSync?.parseChainFile();
    });

    runtimeClient.onParamValues((params) => {
        // Merge isConstant info from chain code sync
        const paramsWithConstantInfo = params.map(p => ({
            ...p,
            isConstant: chainCodeSync?.isParamConstant(p.operator, p.name) ?? true
        }));

        currentParams = paramsWithConstantInfo;
        operatorTreeProvider?.updateParams(paramsWithConstantInfo);
        decorationManager?.updateParams(paramsWithConstantInfo);
        nodeInspectorPanel?.updateParams(paramsWithConstantInfo);
    });

    runtimeClient.onPerformanceStats((stats) => {
        performancePanelProvider?.updateStats(stats);
    });

    runtimeClient.onSoloState((state: SoloState) => {
        operatorTreeProvider?.updateSoloState(state.active, state.operator);
        nodeInspectorPanel?.updateSoloState(state.active ? state.operator : undefined);
        if (state.active) {
            vscode.window.setStatusBarMessage(`$(eye) Solo: ${state.operator}`, 3000);
        }
    });

    runtimeClient.onError((error) => {
        outputChannel.appendLine(`Runtime error: ${error}`);
        writeRuntimeStatus({
            lastError: error,
            lastErrorTime: new Date().toISOString()
        });
        if (error.includes('ECONNREFUSED')) {
            vscode.window.showWarningMessage('Vivid: Cannot connect to runtime. Is it running?');
            writeRuntimeStatus({ connected: false });
        } else if (!error.includes('Parse error')) {
            vscode.window.showErrorMessage(`Vivid runtime error: ${error}`);
        }
    });

    runtimeClient.connect();
    writeRuntimeStatus({ connected: true });
}

function isVividFile(document: vscode.TextDocument): boolean {
    return document.fileName.endsWith('chain.cpp') ||
           document.fileName.endsWith('.wgsl') ||
           document.getText().includes('vivid/vivid.h');
}

function findOperatorAtLine(line: number): OperatorData | undefined {
    // Find operator whose sourceLine matches the cursor line
    // Allow some tolerance for multi-line declarations
    for (const op of currentOperators) {
        if (op.sourceLine === line) {
            return op;
        }
    }
    // If exact match not found, check if we're within a few lines after an operator
    // (for fluent API chains like .scale(4.0f).speed(0.5f))
    for (const op of currentOperators) {
        if (op.sourceLine > 0 && line >= op.sourceLine && line <= op.sourceLine + 3) {
            return op;
        }
    }
    return undefined;
}

function showCompileErrors(message: string) {
    diagnosticCollection.clear();

    const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

    // Parse GCC/Clang error format: file:line:col: error/warning: message
    const errorRegex = /([^:\s][^:]*):(\d+):(\d+):\s*(error|warning|note):\s*(.+)/g;
    let match;

    while ((match = errorRegex.exec(message)) !== null) {
        const [, file, line, col, severity, text] = match;
        const lineNum = parseInt(line) - 1;
        const colNum = parseInt(col) - 1;

        const range = new vscode.Range(
            lineNum, colNum,
            lineNum, colNum + Math.min(text.length, 50)
        );

        let diagSeverity: vscode.DiagnosticSeverity;
        switch (severity) {
            case 'error':
                diagSeverity = vscode.DiagnosticSeverity.Error;
                break;
            case 'warning':
                diagSeverity = vscode.DiagnosticSeverity.Warning;
                break;
            case 'note':
                diagSeverity = vscode.DiagnosticSeverity.Information;
                break;
            default:
                diagSeverity = vscode.DiagnosticSeverity.Error;
        }

        const diagnostic = new vscode.Diagnostic(range, text, diagSeverity);
        diagnostic.source = 'Vivid';

        if (!diagnosticsByFile.has(file)) {
            diagnosticsByFile.set(file, []);
        }
        diagnosticsByFile.get(file)!.push(diagnostic);
    }

    // Set diagnostics for each file
    for (const [file, diagnostics] of diagnosticsByFile) {
        const uri = vscode.Uri.file(file);
        diagnosticCollection.set(uri, diagnostics);
    }

    // Open and reveal first error
    if (diagnosticsByFile.size > 0) {
        const firstFile = diagnosticsByFile.keys().next().value as string | undefined;
        if (firstFile) {
            const firstDiag = diagnosticsByFile.get(firstFile)?.[0];
            if (firstDiag) {
                const uri = vscode.Uri.file(firstFile);
                vscode.workspace.openTextDocument(uri).then(
                    doc => {
                        vscode.window.showTextDocument(doc).then(editor => {
                            editor.revealRange(firstDiag.range, vscode.TextEditorRevealType.InCenter);
                        });
                    },
                    () => { /* File might not exist */ }
                );
            }
        }
    }
}

async function startRuntime(_context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    // Check for custom runtime path (for development/manual installs)
    const config = vscode.workspace.getConfiguration('vivid');
    const customPath = config.get<string>('runtimePath');

    let execPath: string;
    let env = process.env;

    if (customPath) {
        // Development mode: use custom path, skip all download logic
        if (!fs.existsSync(customPath)) {
            vscode.window.showErrorMessage(`Custom runtime not found: ${customPath}`);
            return;
        }
        execPath = customPath;
        outputChannel.appendLine(`Using development runtime: ${customPath}`);
        statusBar?.setDevMode(true);
    } else {
        // Production mode: use RuntimeManager for download/updates
        if (!runtimeManager) {
            vscode.window.showErrorMessage('Runtime manager not initialized');
            return;
        }

        const installed = await runtimeManager.ensureInstalled();
        if (!installed) {
            return;
        }

        execPath = runtimeManager.executablePath;
        env = runtimeManager.getEnvironment();
        statusBar?.setDevMode(false);
    }

    // Stop existing runtime if running
    if (runtimeProcess) {
        runtimeProcess.kill();
        runtimeProcess = undefined;
    }

    const projectPath = workspaceFolders[0].uri.fsPath;

    // Spawn vivid process
    outputChannel.appendLine(`Starting vivid: ${execPath} "${projectPath}"`);
    runtimeProcess = spawn(execPath, [projectPath], { env });

    runtimeProcess.stdout?.on('data', (data) => {
        outputChannel.append(data.toString());
    });

    runtimeProcess.stderr?.on('data', (data) => {
        outputChannel.append(data.toString());
    });

    runtimeProcess.on('close', (code) => {
        outputChannel.appendLine(`Vivid process exited with code ${code}`);
        runtimeProcess = undefined;
        statusBar?.setConnected(false);
    });

    runtimeProcess.on('error', (err) => {
        outputChannel.appendLine(`Failed to start vivid: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to start vivid: ${err.message}`);
    });

    // Wait for runtime to start, then connect
    setTimeout(() => connectToRuntime(), 2000);
}

function stopRuntime() {
    if (runtimeClient) {
        runtimeClient.disconnect();
        runtimeClient = undefined;
    }
    if (runtimeProcess) {
        runtimeProcess.kill();
        runtimeProcess = undefined;
    }
    statusBar?.setConnected(false);
}

function reload() {
    if (runtimeClient) {
        runtimeClient.sendReload();
        outputChannel.appendLine('Reload requested');
    } else {
        vscode.window.showWarningMessage('Not connected to Vivid runtime');
    }
}

function toggleInlineDecorations() {
    const config = vscode.workspace.getConfiguration('vivid');
    const current = config.get<boolean>('showInlineDecorations');
    config.update('showInlineDecorations', !current, vscode.ConfigurationTarget.Global);

    if (decorationManager) {
        decorationManager.setEnabled(!current);
    }
}

async function goToOperator(line: number) {
    // Find chain.cpp in workspace
    const files = await vscode.workspace.findFiles('**/chain.cpp', null, 1);
    if (files.length === 0) {
        vscode.window.showWarningMessage('chain.cpp not found in workspace');
        return;
    }

    const doc = await vscode.workspace.openTextDocument(files[0]);
    const editor = await vscode.window.showTextDocument(doc);

    // Go to line (0-indexed in VS Code)
    const lineIndex = Math.max(0, line - 1);
    const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function editParam(param: ParamData) {
    if (!runtimeClient) {
        vscode.window.showWarningMessage('Not connected to Vivid runtime');
        return;
    }

    // Format current value for display
    const currentValue = formatParamValue(param);

    // Show input box with current value
    const input = await vscode.window.showInputBox({
        prompt: `Edit ${param.operator}.${param.name} (${param.type})`,
        value: currentValue,
        placeHolder: `Range: [${param.min}, ${param.max}]`,
        validateInput: (value) => validateParamInput(value, param)
    });

    if (input === undefined) {
        return; // Cancelled
    }

    // Parse the input and send to runtime
    const newValue = parseParamInput(input, param);
    if (newValue) {
        runtimeClient.sendParamChange(param.operator, param.name, newValue);
        outputChannel.appendLine(`Set ${param.operator}.${param.name} = ${input}`);
    }
}

function formatParamValue(param: ParamData): string {
    const v = param.value;
    switch (param.type) {
        case 'Float':
        case 'Int':
            return v[0].toString();
        case 'Bool':
            return v[0] ? 'true' : 'false';
        case 'Vec2':
            return `${v[0]}, ${v[1]}`;
        case 'Vec3':
            return `${v[0]}, ${v[1]}, ${v[2]}`;
        case 'Vec4':
        case 'Color':
            return `${v[0]}, ${v[1]}, ${v[2]}, ${v[3]}`;
        default:
            return v[0].toString();
    }
}

function validateParamInput(value: string, param: ParamData): string | undefined {
    const parts = value.split(',').map(s => s.trim());

    // Check component count
    const expectedCount = getComponentCount(param.type);
    if (parts.length !== expectedCount) {
        return `Expected ${expectedCount} value(s) for ${param.type}`;
    }

    // Check if all parts are valid numbers (or bool)
    for (const part of parts) {
        if (param.type === 'Bool') {
            if (part !== 'true' && part !== 'false' && part !== '0' && part !== '1') {
                return 'Bool must be true/false or 0/1';
            }
        } else {
            const num = parseFloat(part);
            if (isNaN(num)) {
                return `Invalid number: ${part}`;
            }
        }
    }

    return undefined; // Valid
}

function getComponentCount(type: string): number {
    switch (type) {
        case 'Float':
        case 'Int':
        case 'Bool':
            return 1;
        case 'Vec2':
            return 2;
        case 'Vec3':
            return 3;
        case 'Vec4':
        case 'Color':
            return 4;
        default:
            return 1;
    }
}

function parseParamInput(input: string, param: ParamData): number[] | null {
    const parts = input.split(',').map(s => s.trim());
    const result: number[] = [0, 0, 0, 0];

    for (let i = 0; i < parts.length && i < 4; i++) {
        if (param.type === 'Bool') {
            result[i] = (parts[i] === 'true' || parts[i] === '1') ? 1 : 0;
        } else {
            result[i] = parseFloat(parts[i]);
            if (isNaN(result[i])) {
                return null;
            }
        }
    }

    return result;
}

function soloOperator(operatorName: string) {
    if (!runtimeClient) {
        vscode.window.showWarningMessage('Not connected to Vivid runtime');
        return;
    }

    // Also select the operator in the inspector
    inspectOperator(operatorName);

    runtimeClient.sendSoloNode(operatorName);
    outputChannel.appendLine(`Solo mode: ${operatorName}`);
}

function inspectOperator(operatorName: string) {
    const operator = currentOperators.find(op => op.name === operatorName);
    if (operator) {
        const params = currentParams.filter(p => p.operator === operatorName);
        nodeInspectorPanel?.setSelectedOperator(operator, params);
        outputChannel.appendLine(`Inspecting: ${operatorName}`);
    }
}

function exitSolo() {
    if (!runtimeClient) {
        vscode.window.showWarningMessage('Not connected to Vivid runtime');
        return;
    }

    runtimeClient.sendSoloExit();
    outputChannel.appendLine('Exited solo mode');
}

async function createProject(context: vscode.ExtensionContext) {
    if (!runtimeManager) {
        vscode.window.showErrorMessage('Runtime manager not initialized');
        return;
    }

    // Ensure runtime is installed (we need the vivid CLI)
    const installed = await runtimeManager.ensureInstalled();
    if (!installed) {
        return;
    }

    // Step 1: Get project name
    const projectName = await vscode.window.showInputBox({
        prompt: 'Enter project name',
        placeHolder: 'my-vivid-project',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Project name is required';
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                return 'Project name can only contain letters, numbers, hyphens, and underscores';
            }
            return undefined;
        }
    });

    if (!projectName) {
        return; // User cancelled
    }

    // Step 2: Select template
    const templates = [
        { label: 'blank', description: 'Default template with Noise operator and offset animation' },
        { label: 'minimal', description: 'Bare minimum template (empty skeleton)' },
        { label: 'noise-demo', description: 'Noise generator with animation' },
        { label: 'feedback', description: 'Recursive feedback effects' },
        { label: 'audio-visualizer', description: 'FFT analysis and beat detection with reactive visuals' },
        { label: '3d-orbit', description: '3D rendering with orbital camera' }
    ];

    const selectedTemplate = await vscode.window.showQuickPick(templates, {
        placeHolder: 'Select a project template',
        title: 'Vivid Project Template'
    });

    if (!selectedTemplate) {
        return; // User cancelled
    }

    // Step 3: Select addons (multi-select)
    const addons = [
        { label: 'vivid-audio', description: 'Audio input, FFT analysis, beat detection, oscillators', picked: false },
        { label: 'vivid-video', description: 'Video playback (HAP codec, platform decoders)', picked: false },
        { label: 'vivid-render3d', description: '3D rendering with PBR materials, GLTF loading, CSG', picked: false }
    ];

    const selectedAddons = await vscode.window.showQuickPick(addons, {
        placeHolder: 'Select addons to include (optional)',
        title: 'Vivid Addons',
        canPickMany: true
    });

    // Step 4: Select parent directory
    const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Parent Folder',
        title: 'Where do you want to create the project?'
    });

    if (!folderUri || folderUri.length === 0) {
        return; // User cancelled
    }

    const parentPath = folderUri[0].fsPath;
    const projectPath = `${parentPath}/${projectName}`;

    // Build command arguments
    const args = ['new', projectName, '--template', selectedTemplate.label, '--yes'];

    if (selectedAddons && selectedAddons.length > 0) {
        const addonList = selectedAddons.map(a => a.label).join(',');
        args.push('--addons', addonList);
    }

    outputChannel.appendLine(`Creating project: vivid ${args.join(' ')}`);
    outputChannel.appendLine(`In directory: ${parentPath}`);
    outputChannel.show();

    // Execute vivid new command
    const vividPath = runtimeManager.executablePath;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating Vivid project "${projectName}"...`,
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve, reject) => {
            const proc = spawn(vividPath, args, {
                cwd: parentPath,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
                outputChannel.append(data.toString());
            });

            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
                outputChannel.append(data.toString());
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    outputChannel.appendLine(`\nProject created successfully at ${projectPath}`);

                    // Create .vscode/c_cpp_properties.json for IntelliSense
                    const vscodeDir = `${projectPath}/.vscode`;
                    const cppPropertiesPath = `${vscodeDir}/c_cpp_properties.json`;
                    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
                    const platformName = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Win32' : 'Linux';

                    const cppProperties = {
                        configurations: [
                            {
                                name: platformName,
                                includePath: [
                                    '${workspaceFolder}/**',
                                    `${homeDir}/.vivid/include`
                                ],
                                cStandard: 'c17',
                                cppStandard: 'c++17'
                            }
                        ],
                        version: 4
                    };

                    try {
                        fs.mkdirSync(vscodeDir, { recursive: true });
                        fs.writeFileSync(cppPropertiesPath, JSON.stringify(cppProperties, null, 4));
                        outputChannel.appendLine(`Created ${cppPropertiesPath}`);
                    } catch (err) {
                        outputChannel.appendLine(`Warning: Failed to create c_cpp_properties.json: ${err}`);
                    }

                    resolve();
                } else {
                    outputChannel.appendLine(`\nProject creation failed with code ${code}`);
                    reject(new Error(stderr || 'Unknown error'));
                }
            });

            proc.on('error', (err) => {
                outputChannel.appendLine(`\nFailed to run vivid: ${err.message}`);
                reject(err);
            });
        });
    });

    // Mark this project for auto-start when opened
    context.globalState.update('vivid.autoStartProject', projectPath);

    // Automatically open the new project in a new window
    vscode.window.showInformationMessage(`Project "${projectName}" created! Opening...`);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), true);
}

async function refreshOperatorLibrary() {
    if (!operatorCatalog || !operatorLibraryPanel) {
        return;
    }

    // Get runtime path
    const config = vscode.workspace.getConfiguration('vivid');
    const customPath = config.get<string>('runtimePath');
    let runtimePath: string | undefined;

    if (customPath) {
        runtimePath = customPath;
    } else if (runtimeManager?.isInstalled()) {
        runtimePath = runtimeManager.executablePath;
    }

    if (!runtimePath) {
        operatorLibraryPanel.setLoadError('Vivid runtime not found');
        return;
    }

    operatorLibraryPanel.setLoading(true);

    const loaded = await operatorCatalog.loadFromRuntime(runtimePath);

    if (loaded) {
        operatorLibraryPanel.setCatalog(operatorCatalog);
    } else {
        operatorLibraryPanel.setLoadError('Failed to load operators from runtime');
    }
}

async function addOperator() {
    if (!operatorCatalog || !chainCodeSync) {
        vscode.window.showErrorMessage('Operator catalog not initialized');
        return;
    }

    // Get runtime path to load catalog
    const config = vscode.workspace.getConfiguration('vivid');
    const customPath = config.get<string>('runtimePath');
    let runtimePath: string | undefined;

    if (customPath) {
        runtimePath = customPath;
    } else if (runtimeManager?.isInstalled()) {
        runtimePath = runtimeManager.executablePath;
    }

    if (!runtimePath) {
        vscode.window.showErrorMessage('Vivid runtime not found. Please install the runtime first.');
        return;
    }

    // Load catalog if not already loaded
    if (!operatorCatalog.isLoaded()) {
        const loaded = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Loading operator catalog...',
            cancellable: false
        }, async () => {
            return await operatorCatalog!.loadFromRuntime(runtimePath!);
        });

        if (!loaded) {
            vscode.window.showErrorMessage('Failed to load operator catalog from runtime');
            return;
        }
    }

    // Step 1: Show category picker
    const categoryItems = operatorCatalog.getCategoryQuickPickItems();
    const selectedCategory = await vscode.window.showQuickPick(categoryItems, {
        placeHolder: 'Select operator category',
        title: 'Add Operator'
    });

    if (!selectedCategory) {
        return; // User cancelled
    }

    // Step 2: Show operators in selected category
    const operatorItems = operatorCatalog.getOperatorQuickPickItems(selectedCategory.label);
    const selectedOperator = await vscode.window.showQuickPick(operatorItems, {
        placeHolder: `Select ${selectedCategory.label} operator`,
        title: `Add ${selectedCategory.label} Operator`
    });

    if (!selectedOperator) {
        return; // User cancelled
    }

    // Get the operator definition
    const operator = operatorCatalog.getOperator(selectedOperator.label);
    if (!operator) {
        vscode.window.showErrorMessage(`Operator "${selectedOperator.label}" not found`);
        return;
    }

    // Determine insertion point based on current cursor
    const editor = vscode.window.activeTextEditor;
    let afterLine = -1;
    let previousOperatorVar: string | undefined;

    if (editor && editor.document.fileName.endsWith('chain.cpp')) {
        const cursorLine = editor.selection.active.line + 1; // 1-indexed

        // Find operator at or near cursor
        const operatorAtCursor = findOperatorAtLine(cursorLine);
        if (operatorAtCursor) {
            // Insert after this operator
            afterLine = operatorAtCursor.sourceLine;
            // Find the variable name for this operator
            const operatorInfo = currentOperators.find(op => op.name === operatorAtCursor.name);
            if (operatorInfo) {
                // Get variable name from chain code sync
                previousOperatorVar = chainCodeSync.getOperatorVariable(operatorInfo.name);
            }
        }
    }

    // Insert the operator
    const result = await chainCodeSync.insertOperator(operator, afterLine, previousOperatorVar);

    if (result) {
        outputChannel.appendLine(`Added operator ${operator.name} as "${result.variableName}" at line ${result.line}`);

        // Open chain.cpp and position cursor at the new code
        const files = await vscode.workspace.findFiles('**/chain.cpp', null, 1);
        if (files.length > 0) {
            const doc = await vscode.workspace.openTextDocument(files[0]);
            const editor = await vscode.window.showTextDocument(doc);
            const position = new vscode.Position(result.line - 1, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }

        // Trigger hot reload if connected
        if (runtimeClient) {
            // Give VS Code a moment to save the file, then reload
            setTimeout(() => {
                runtimeClient?.sendReload();
            }, 500);
        }

        vscode.window.setStatusBarMessage(`$(check) Added ${operator.name}`, 3000);
    } else {
        vscode.window.showErrorMessage('Failed to insert operator');
    }
}

async function manageAddons() {
    if (!addonManager) {
        vscode.window.showErrorMessage('Addon manager not initialized');
        return;
    }

    // Get runtime path
    const config = vscode.workspace.getConfiguration('vivid');
    const customPath = config.get<string>('runtimePath');

    if (customPath) {
        addonManager.setRuntimePath(customPath);
    } else if (runtimeManager?.isInstalled()) {
        addonManager.setRuntimePath(runtimeManager.executablePath);
    } else {
        // Try to ensure runtime is installed
        const installed = await runtimeManager?.ensureInstalled();
        if (!installed) {
            vscode.window.showErrorMessage('Vivid runtime not found. Please install it first.');
            return;
        }
        addonManager.setRuntimePath(runtimeManager!.executablePath);
    }

    await showAddonManager(addonManager);
}

async function bundleProject() {
    // Check platform - bundle only works on macOS
    if (process.platform !== 'darwin') {
        vscode.window.showErrorMessage('Bundle is only available on macOS.');
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const projectPath = workspaceFolders[0].uri.fsPath;

    // Check for chain.cpp
    const chainPath = path.join(projectPath, 'chain.cpp');
    if (!fs.existsSync(chainPath)) {
        vscode.window.showErrorMessage('No chain.cpp found in workspace. Is this a Vivid project?');
        return;
    }

    // Get runtime path
    const config = vscode.workspace.getConfiguration('vivid');
    const customPath = config.get<string>('runtimePath');
    let execPath: string;

    if (customPath) {
        execPath = customPath;
    } else if (runtimeManager?.isInstalled()) {
        execPath = runtimeManager.executablePath;
    } else {
        const installed = await runtimeManager?.ensureInstalled();
        if (!installed) {
            vscode.window.showErrorMessage('Vivid runtime not found. Please install it first.');
            return;
        }
        execPath = runtimeManager!.executablePath;
    }

    // Get app name from user
    const projectName = path.basename(projectPath);
    const defaultAppName = projectName.charAt(0).toUpperCase() + projectName.slice(1).replace(/-/g, '');

    const appName = await vscode.window.showInputBox({
        prompt: 'Enter app name',
        value: defaultAppName,
        placeHolder: 'MyVividApp',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'App name is required';
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                return 'App name can only contain letters, numbers, hyphens, and underscores';
            }
            return undefined;
        }
    });

    if (!appName) {
        return; // User cancelled
    }

    // Ask for output location
    const outputUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(path.dirname(projectPath), `${appName}.app`)),
        filters: { 'macOS Application': ['app'] },
        title: 'Save Application Bundle'
    });

    if (!outputUri) {
        return; // User cancelled
    }

    const outputPath = outputUri.fsPath;

    // Check if output already exists
    if (fs.existsSync(outputPath)) {
        const overwrite = await vscode.window.showWarningMessage(
            `${path.basename(outputPath)} already exists. Overwrite?`,
            { modal: true },
            'Overwrite'
        );
        if (overwrite !== 'Overwrite') {
            return;
        }
        // Remove existing
        fs.rmSync(outputPath, { recursive: true, force: true });
    }

    // Run vivid bundle
    outputChannel.appendLine(`Bundling: vivid bundle "${projectPath}" -o "${outputPath}" -n "${appName}"`);
    outputChannel.show();

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Bundling ${appName}.app...`,
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve, reject) => {
            const args = ['bundle', projectPath, '-o', outputPath, '-n', appName];
            const proc = spawn(execPath, args);

            proc.stdout?.on('data', (data) => {
                outputChannel.append(data.toString());
            });

            proc.stderr?.on('data', (data) => {
                outputChannel.append(data.toString());
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    outputChannel.appendLine(`\nBundle created: ${outputPath}`);
                    resolve();
                } else {
                    outputChannel.appendLine(`\nBundle failed with code ${code}`);
                    reject(new Error(`Bundle failed with code ${code}`));
                }
            });

            proc.on('error', (err) => {
                outputChannel.appendLine(`\nFailed to run vivid: ${err.message}`);
                reject(err);
            });
        });
    });

    // Show success message with option to reveal in Finder
    const action = await vscode.window.showInformationMessage(
        `Successfully created ${appName}.app`,
        'Reveal in Finder',
        'Run App'
    );

    if (action === 'Reveal in Finder') {
        spawn('open', ['-R', outputPath]);
    } else if (action === 'Run App') {
        spawn('open', [outputPath]);
    }
}

export function deactivate() {
    stopRuntime();
    if (hookServer) {
        hookServer.close();
        hookServer = undefined;
    }
}
