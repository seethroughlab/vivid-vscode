import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { RuntimeClient, NodeUpdate, SoloState, WindowState } from './runtimeClient';
import { DecorationManager } from './decorations';
import { StatusBar } from './statusBar';
import { OperatorTreeProvider, ParamData, OperatorData } from './operatorTreeView';
import { PerformancePanelProvider } from './performancePanel';
import { WindowControlsPanelProvider } from './windowControlsPanel';
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
let windowControlsPanelProvider: WindowControlsPanelProvider | undefined;
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

    // Check vivid setup (onboarding for new users)
    // This runs async and doesn't block activation
    checkVividSetup(context).then((configured) => {
        if (configured) {
            outputChannel.appendLine('Vivid source path configured');
        }
    });

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

    // Register window controls panel
    windowControlsPanelProvider = new WindowControlsPanelProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            WindowControlsPanelProvider.viewType,
            windowControlsPanelProvider
        )
    );

    // Wire up window controls callback
    windowControlsPanelProvider.setWindowControlHandler((setting, value) => {
        if (runtimeClient) {
            runtimeClient.sendWindowControl(setting, value);
            outputChannel.appendLine(`Window control: ${setting} = ${value}`);
        }
    });

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
        vscode.commands.registerCommand('vivid.bundleProject', () => bundleProject()),
        vscode.commands.registerCommand('vivid.createOperatorTemplate', () => createOperatorTemplate())
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

    // CLAUDE.md token limit warning
    // Claude has a 200K token context window, but CLAUDE.md should be concise
    // to leave room for code, conversation, and tool outputs
    const CLAUDE_MD_TOKEN_WARNING_THRESHOLD = 8000;  // ~32KB of text
    const CLAUDE_MD_TOKEN_LIMIT = 16000;  // ~64KB - strongly discouraged

    function estimateTokens(text: string): number {
        // Rough estimate: ~4 characters per token for English text
        // This is a conservative estimate; actual tokenization varies
        return Math.ceil(text.length / 4);
    }

    function checkClaudeMdSize(uri: vscode.Uri) {
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const estimatedTokens = estimateTokens(content);
            const fileName = path.basename(uri.fsPath);

            if (estimatedTokens > CLAUDE_MD_TOKEN_LIMIT) {
                vscode.window.showErrorMessage(
                    `${fileName} is very large (~${estimatedTokens.toLocaleString()} tokens). ` +
                    `Claude's context window is limited. Consider splitting into multiple files or condensing.`,
                    'Open File'
                ).then(choice => {
                    if (choice === 'Open File') {
                        vscode.window.showTextDocument(uri);
                    }
                });
            } else if (estimatedTokens > CLAUDE_MD_TOKEN_WARNING_THRESHOLD) {
                vscode.window.showWarningMessage(
                    `${fileName} is getting large (~${estimatedTokens.toLocaleString()} tokens). ` +
                    `Consider keeping it concise to leave context for code and conversation.`,
                    'Open File'
                ).then(choice => {
                    if (choice === 'Open File') {
                        vscode.window.showTextDocument(uri);
                    }
                });
            }
        } catch (e) {
            // Ignore read errors
        }
    }

    // Watch for CLAUDE.md file saves
    const claudeMdWatcher = vscode.workspace.createFileSystemWatcher('**/CLAUDE.md');
    claudeMdWatcher.onDidChange(checkClaudeMdSize);
    claudeMdWatcher.onDidCreate(checkClaudeMdSize);
    context.subscriptions.push(claudeMdWatcher);

    // Also check on save for files already open
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.fileName.endsWith('CLAUDE.md')) {
                checkClaudeMdSize(document.uri);
            }
        })
    );

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

    // Check for updates on startup if enabled (skip in dev mode when vividRoot is set)
    const isDevMode = !!runtimeManager?.getVividRoot();
    if (!isDevMode && config.get<boolean>('checkUpdatesOnStart') && runtimeManager?.isInstalled()) {
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

// ============================================================================
// Vivid Setup / Onboarding
// ============================================================================

/**
 * Check if a directory is a valid vivid source root
 */
function isValidVividRoot(dir: string): boolean {
    return fs.existsSync(path.join(dir, 'core')) &&
           fs.existsSync(path.join(dir, 'examples')) &&
           fs.existsSync(path.join(dir, 'CMakeLists.txt'));
}

/**
 * Save the vivid root to VS Code settings
 */
async function saveVividRoot(vividRoot: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('vivid');
    await config.update('vividRoot', vividRoot, vscode.ConfigurationTarget.Global);
    outputChannel?.appendLine(`Vivid root set to: ${vividRoot}`);
}

/**
 * Ensure the projects folder structure exists
 */
async function ensureProjectsStructure(vividRoot: string): Promise<void> {
    const projectsDir = path.join(vividRoot, 'projects');
    const myProjectsDir = path.join(projectsDir, 'my-projects');
    const examplesWorkDir = path.join(projectsDir, 'examples');

    // Create projects directory
    if (!fs.existsSync(projectsDir)) {
        fs.mkdirSync(projectsDir, { recursive: true });
        outputChannel?.appendLine(`Created projects directory: ${projectsDir}`);
    }

    // Create my-projects directory with .gitignore
    if (!fs.existsSync(myProjectsDir)) {
        fs.mkdirSync(myProjectsDir, { recursive: true });
        fs.writeFileSync(
            path.join(myProjectsDir, '.gitignore'),
            '# User projects - not tracked in vivid repo\n*\n!.gitignore\n'
        );
        outputChannel?.appendLine(`Created my-projects directory: ${myProjectsDir}`);
    }

    // Copy examples for user modification (if not already done)
    if (!fs.existsSync(examplesWorkDir)) {
        const sourceExamples = path.join(vividRoot, 'examples');
        if (fs.existsSync(sourceExamples)) {
            await copyDirectory(sourceExamples, examplesWorkDir);
            fs.writeFileSync(
                path.join(examplesWorkDir, 'README.md'),
                '# Working Examples\n\nThese are copies of the original examples that you can modify.\nOriginals are in `../examples/` (read-only reference).\n'
            );
            outputChannel?.appendLine(`Copied examples to: ${examplesWorkDir}`);
        }
    }
}

/**
 * Recursively copy a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await copyDirectory(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Let user select an existing vivid checkout
 */
async function selectExistingVividPath(): Promise<boolean> {
    const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select Vivid Source Directory',
        openLabel: 'Select Vivid Root'
    });

    if (result && result.length > 0) {
        const selectedPath = result[0].fsPath;
        if (isValidVividRoot(selectedPath)) {
            await saveVividRoot(selectedPath);
            await ensureProjectsStructure(selectedPath);
            vscode.window.showInformationMessage(`Vivid configured at: ${selectedPath}`);
            return true;
        } else {
            vscode.window.showErrorMessage(
                'Invalid Vivid directory. Please select a folder containing core/, examples/, and CMakeLists.txt'
            );
        }
    }
    return false;
}

/**
 * Clone vivid from GitHub to user-selected location
 */
async function cloneVividFromGitHub(): Promise<boolean> {
    // Ask where to clone
    const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select Parent Directory for Vivid',
        openLabel: 'Clone Here'
    });

    if (!result || result.length === 0) {
        return false;
    }

    const parentDir = result[0].fsPath;
    const vividDir = path.join(parentDir, 'vivid');

    // Check if vivid folder already exists
    if (fs.existsSync(vividDir)) {
        const overwrite = await vscode.window.showWarningMessage(
            `A 'vivid' folder already exists at ${parentDir}. Use it anyway?`,
            'Use Existing',
            'Cancel'
        );
        if (overwrite === 'Use Existing' && isValidVividRoot(vividDir)) {
            await saveVividRoot(vividDir);
            await ensureProjectsStructure(vividDir);
            return true;
        }
        return false;
    }

    // Clone repository with progress
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Cloning Vivid from GitHub...',
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'This may take a minute...' });

        return new Promise<boolean>((resolve) => {
            const git = spawn('git', ['clone', '--depth', '1', 'https://github.com/seethroughlab/vivid.git', vividDir]);

            let stderr = '';
            git.stderr.on('data', (data) => {
                stderr += data.toString();
                // Git outputs progress to stderr
                const match = data.toString().match(/(\d+)%/);
                if (match) {
                    progress.report({ message: `Cloning... ${match[1]}%` });
                }
            });

            git.on('close', async (code) => {
                if (code === 0) {
                    await saveVividRoot(vividDir);
                    await ensureProjectsStructure(vividDir);
                    vscode.window.showInformationMessage(`Vivid cloned to: ${vividDir}`);
                    resolve(true);
                } else {
                    vscode.window.showErrorMessage(`Failed to clone Vivid: ${stderr}`);
                    resolve(false);
                }
            });

            git.on('error', (err) => {
                vscode.window.showErrorMessage(`Git not found. Please install git and try again. Error: ${err.message}`);
                resolve(false);
            });
        });
    });
}

/**
 * Check if user has legacy ~/.vivid installation
 */
function hasLegacyInstallation(): boolean {
    const legacyDir = path.join(os.homedir(), '.vivid');
    const legacyBinary = path.join(legacyDir, 'bin', process.platform === 'win32' ? 'vivid.exe' : 'vivid');
    return fs.existsSync(legacyBinary);
}

/**
 * Check if vivid is set up, prompt for setup if not
 */
async function checkVividSetup(context: vscode.ExtensionContext): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('vivid');
    const vividRoot = config.get<string>('vividRoot');

    // If vividRoot is set and valid, we're configured
    if (vividRoot && isValidVividRoot(vividRoot)) {
        // Update runtime manager with vivid root
        runtimeManager?.setVividRoot(vividRoot);
        return true;
    }

    // Check if this is a fresh install or if user dismissed before
    const setupDismissed = context.globalState.get<boolean>('vivid.setupDismissed');
    if (setupDismissed) {
        return false;
    }

    // Check for legacy installation - offer migration
    if (hasLegacyInstallation()) {
        const migrationChoice = await vscode.window.showInformationMessage(
            'Vivid has a new setup that gives Claude Code access to source code for better AI assistance. Would you like to upgrade?',
            'Set Up Now',
            'Keep Old Setup',
            'Learn More'
        );

        if (migrationChoice === 'Set Up Now') {
            // Same flow as new user - point to existing or clone
            const setupChoice = await vscode.window.showQuickPick([
                {
                    label: 'Point to Existing Checkout',
                    description: 'I already have the vivid source code cloned'
                },
                {
                    label: 'Clone from GitHub',
                    description: 'Download the source code automatically'
                }
            ], {
                placeHolder: 'How would you like to set up Vivid source access?',
                title: 'Vivid Source Setup'
            });

            if (setupChoice?.label === 'Point to Existing Checkout') {
                const success = await selectExistingVividPath();
                if (success) {
                    await promptForBinaryDownload();
                    await reconfigureMcp();
                }
                return success;
            } else if (setupChoice?.label === 'Clone from GitHub') {
                const success = await cloneVividFromGitHub();
                if (success) {
                    await promptForBinaryDownload();
                    await reconfigureMcp();
                }
                return success;
            }
        } else if (migrationChoice === 'Keep Old Setup') {
            // Remember that user wants to keep old setup
            await context.globalState.update('vivid.setupDismissed', true);
            outputChannel?.appendLine('Keeping legacy ~/.vivid setup');
            return false;
        } else if (migrationChoice === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse(
                'https://github.com/seethroughlab/vivid-vscode#source-code-access'
            ));
        }

        return false;
    }

    // New user - show onboarding dialog
    const choice = await vscode.window.showInformationMessage(
        'Welcome to Vivid! To get the best experience (including AI assistance), we need access to the Vivid source code.',
        'Point to Existing Checkout',
        'Clone from GitHub',
        'Later'
    );

    if (choice === 'Point to Existing Checkout') {
        const success = await selectExistingVividPath();
        if (success) {
            await promptForBinaryDownload();
        }
        return success;
    } else if (choice === 'Clone from GitHub') {
        const success = await cloneVividFromGitHub();
        if (success) {
            await promptForBinaryDownload();
        }
        return success;
    } else if (choice === 'Later') {
        // Remember that user dismissed, don't ask again this session
        await context.globalState.update('vivid.setupDismissed', true);
    }

    return false;
}

/**
 * Reconfigure MCP after migration to new workflow
 */
async function reconfigureMcp(): Promise<void> {
    const { configureVividMcp } = await import('./mcpConfigChecker');
    const success = await configureVividMcp();
    if (success) {
        vscode.window.showInformationMessage(
            'Vivid MCP updated. Restart Claude Code for AI to access source documentation.'
        );
    }
}

/**
 * Prompt user to download binary if not present
 */
async function promptForBinaryDownload(): Promise<void> {
    const config = vscode.workspace.getConfiguration('vivid');
    const vividRoot = config.get<string>('vividRoot');

    if (!vividRoot || !runtimeManager) {
        return;
    }

    // Check if binary exists
    const binaryPath = path.join(vividRoot, 'build', 'bin', process.platform === 'win32' ? 'vivid.exe' : 'vivid');
    if (fs.existsSync(binaryPath)) {
        return; // Binary already exists
    }

    const choice = await vscode.window.showInformationMessage(
        'Vivid runtime binary not found. Download now? (No build required)',
        'Download',
        'Later'
    );

    if (choice === 'Download') {
        await runtimeManager.installOrUpdate();
    }
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

    runtimeClient.onWindowState((state: WindowState) => {
        windowControlsPanelProvider?.updateState(state);
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

    if (!runtimeManager) {
        vscode.window.showErrorMessage('Runtime manager not initialized');
        return;
    }

    // Ensure runtime is available
    const installed = await runtimeManager.ensureInstalled();
    if (!installed) {
        return;
    }

    const execPath = runtimeManager.executablePath;
    const env = runtimeManager.getEnvironment();
    const isDevMode = !!runtimeManager.getVividRoot();
    statusBar?.setDevMode(isDevMode);

    if (isDevMode) {
        outputChannel.appendLine(`Using development runtime: ${execPath}`);
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
    // Default to projects/my-projects if vividRoot is configured
    const config = vscode.workspace.getConfiguration('vivid');
    const vividRoot = config.get<string>('vividRoot');
    const defaultProjectsPath = vividRoot ? path.join(vividRoot, 'projects', 'my-projects') : undefined;

    let parentPath: string;

    if (defaultProjectsPath && fs.existsSync(defaultProjectsPath)) {
        // Offer quick pick between default location and custom
        const locationChoice = await vscode.window.showQuickPick([
            {
                label: 'My Projects',
                description: defaultProjectsPath,
                detail: 'Recommended - inside your Vivid installation'
            },
            {
                label: 'Choose Location...',
                description: 'Select a different folder'
            }
        ], {
            placeHolder: 'Where do you want to create the project?',
            title: 'Project Location'
        });

        if (!locationChoice) {
            return; // User cancelled
        }

        if (locationChoice.label === 'My Projects') {
            parentPath = defaultProjectsPath;
        } else {
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
            parentPath = folderUri[0].fsPath;
        }
    } else {
        // No vividRoot configured - use folder picker
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
        parentPath = folderUri[0].fsPath;
    }
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

    const vividExecPath = runtimeManager.executablePath;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating Vivid project "${projectName}"...`,
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve, reject) => {
            const proc = spawn(vividExecPath, args, {
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
                    const platformName = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Win32' : 'Linux';

                    // Use source include path if vividRoot is configured, otherwise fallback
                    const includePaths: string[] = ['${workspaceFolder}/**'];
                    if (runtimeManager?.includePath) {
                        includePaths.push(runtimeManager.includePath);
                    } else {
                        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
                        includePaths.push(`${homeDir}/.vivid/include`);
                    }

                    const cppProperties = {
                        configurations: [
                            {
                                name: platformName,
                                includePath: includePaths,
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

    if (!runtimeManager?.isInstalled()) {
        operatorLibraryPanel.setLoadError('Vivid runtime not found');
        return;
    }

    operatorLibraryPanel.setLoading(true);

    const loaded = await operatorCatalog.loadFromRuntime(runtimeManager.executablePath);

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

    if (!runtimeManager?.isInstalled()) {
        vscode.window.showErrorMessage('Vivid runtime not found. Please install the runtime first.');
        return;
    }

    const runtimePath = runtimeManager.executablePath;

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

    if (!runtimeManager?.isInstalled()) {
        const installed = await runtimeManager?.ensureInstalled();
        if (!installed) {
            vscode.window.showErrorMessage('Vivid runtime not found. Please install it first.');
            return;
        }
    }

    addonManager.setRuntimePath(runtimeManager!.executablePath);
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

    if (!runtimeManager?.isInstalled()) {
        const installed = await runtimeManager?.ensureInstalled();
        if (!installed) {
            vscode.window.showErrorMessage('Vivid runtime not found. Please install it first.');
            return;
        }
    }

    const execPath = runtimeManager!.executablePath;

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

async function createOperatorTemplate() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    // Step 1: Get operator name
    const operatorName = await vscode.window.showInputBox({
        prompt: 'Enter operator name (e.g., MyEffect, ColorShift)',
        placeHolder: 'MyCustomOperator',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Operator name is required';
            }
            if (!/^[A-Z][a-zA-Z0-9]*$/.test(value)) {
                return 'Operator name must be PascalCase (start with uppercase, letters/numbers only)';
            }
            return undefined;
        }
    });

    if (!operatorName) {
        return; // User cancelled
    }

    // Step 2: Select operator type
    const operatorTypes = [
        { label: 'Shader Effect', description: 'Process input texture with WGSL shader (most common)' },
        { label: 'Shader Generator', description: 'Generate textures from scratch (noise, gradients, shapes)' },
        { label: 'Value/Modulator', description: 'Output scalar values for animation/modulation' },
        { label: 'Audio Synth', description: 'Generate or process audio (requires vivid-audio)' },
        { label: 'Audio Analyzer', description: 'Extract values from audio (RMS, spectrum, beats)' }
    ];

    const selectedType = await vscode.window.showQuickPick(operatorTypes, {
        placeHolder: 'Select operator type',
        title: 'Operator Type'
    });

    if (!selectedType) {
        return; // User cancelled
    }

    // Step 3: Create operators directory if it doesn't exist
    const projectPath = workspaceFolders[0].uri.fsPath;
    const operatorsDir = path.join(projectPath, 'operators');

    if (!fs.existsSync(operatorsDir)) {
        fs.mkdirSync(operatorsDir, { recursive: true });
    }

    // Step 4: Generate template code
    const fileName = `${operatorName.charAt(0).toLowerCase()}${operatorName.slice(1)}.h`;
    const filePath = path.join(operatorsDir, fileName);

    if (fs.existsSync(filePath)) {
        const overwrite = await vscode.window.showWarningMessage(
            `${fileName} already exists. Overwrite?`,
            'Overwrite',
            'Cancel'
        );
        if (overwrite !== 'Overwrite') {
            return;
        }
    }

    const template = generateOperatorTemplate(operatorName, selectedType.label);
    fs.writeFileSync(filePath, template);

    // Step 5: Open the new file
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    // Step 6: Show next steps
    const includeCode = `#include "operators/${fileName}"`;
    const usageCode = `chain.add<${operatorName}>("my${operatorName}");`;

    vscode.window.showInformationMessage(
        `Created ${fileName}. Add to chain.cpp: ${includeCode}`,
        'Copy Include'
    ).then(action => {
        if (action === 'Copy Include') {
            vscode.env.clipboard.writeText(includeCode);
            vscode.window.setStatusBarMessage('$(check) Include copied to clipboard', 3000);
        }
    });

    outputChannel.appendLine(`Created custom operator template: ${filePath}`);
    outputChannel.appendLine(`To use: ${includeCode}`);
    outputChannel.appendLine(`Then: ${usageCode}`);
}

function generateOperatorTemplate(name: string, templateType: string): string {
    const uniformsName = `${name}Uniforms`;

    if (templateType === 'Shader Effect') {
        return `#pragma once

#include <vivid/vivid.h>
#include <vivid/effects/simple_texture_effect.h>

using namespace vivid;
using namespace vivid::effects;

/**
 * @brief Uniform buffer for ${name}
 *
 * WGSL alignment rules: floats pack into vec4s
 * Add padding to reach 16-byte boundaries
 */
struct ${uniformsName} {
    float intensity;
    float time;
    float _pad[2];  // Padding to 16 bytes
};

/**
 * @brief ${name} - Custom shader effect
 *
 * Processes input texture through a WGSL fragment shader.
 * Uses the SimpleTextureEffect CRTP pattern for automatic
 * pipeline setup and uniform buffer management.
 */
class ${name} : public SimpleTextureEffect<${name}, ${uniformsName}> {
public:
    // Parameters (exposed to UI and code)
    Param<float> intensity{"intensity", 1.0f, 0.0f, 2.0f};

    /**
     * @brief Return uniform values for the shader
     * Called each frame before rendering
     */
    ${uniformsName} getUniforms() const {
        return {
            static_cast<float>(intensity),
            m_time,
            {0, 0}
        };
    }

    void process(Context& ctx) override {
        m_time = ctx.time();
        SimpleTextureEffect::process(ctx);
    }

    std::string name() const override { return "${name}"; }

protected:
    /**
     * @brief WGSL fragment shader source
     *
     * Available bindings:
     * - @group(0) @binding(0) var<uniform> uniforms: ${uniformsName}
     * - @group(0) @binding(1) var inputTex: texture_2d<f32>
     * - @group(0) @binding(2) var texSampler: sampler
     */
    const char* fragmentShader() const override {
        return R"(
struct Uniforms {
    intensity: f32,
    time: f32,
    _pad1: f32,
    _pad2: f32
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f
};

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(inputTex, texSampler, input.uv);

    // Example: intensity-based color adjustment
    return vec4f(color.rgb * uniforms.intensity, color.a);
}
        )";
    }

private:
    float m_time = 0.0f;
};
`;
    } else if (templateType === 'Shader Generator') {
        return `#pragma once

#include <vivid/vivid.h>
#include <vivid/effects/simple_texture_effect.h>

using namespace vivid;
using namespace vivid::effects;

/**
 * @brief Uniform buffer for ${name}
 */
struct ${uniformsName} {
    float time;
    float speed;
    float scale;
    float _pad;
};

/**
 * @brief ${name} - Custom texture generator
 *
 * Generates textures from scratch using WGSL shaders.
 * Uses the SimpleGeneratorEffect CRTP pattern (no input texture).
 */
class ${name} : public SimpleGeneratorEffect<${name}, ${uniformsName}> {
public:
    // Parameters
    Param<float> speed{"speed", 1.0f, 0.0f, 10.0f};
    Param<float> scale{"scale", 4.0f, 0.1f, 20.0f};

    /**
     * @brief Return uniform values for the shader
     */
    ${uniformsName} getUniforms() const {
        return {
            m_time,
            static_cast<float>(speed),
            static_cast<float>(scale),
            0
        };
    }

    void process(Context& ctx) override {
        m_time = ctx.time();
        SimpleGeneratorEffect::process(ctx);
    }

    std::string name() const override { return "${name}"; }

protected:
    /**
     * @brief WGSL fragment shader source
     *
     * Available bindings:
     * - @group(0) @binding(0) var<uniform> uniforms: ${uniformsName}
     * - @group(0) @binding(1) var texSampler: sampler
     */
    const char* fragmentShader() const override {
        return R"(
struct Uniforms {
    time: f32,
    speed: f32,
    scale: f32,
    _pad: f32
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var texSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f
};

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    let t = uniforms.time * uniforms.speed;
    let uv = input.uv * uniforms.scale;

    // Example: animated gradient pattern
    let r = sin(uv.x + t) * 0.5 + 0.5;
    let g = sin(uv.y + t * 1.3) * 0.5 + 0.5;
    let b = sin(uv.x + uv.y + t * 0.7) * 0.5 + 0.5;

    return vec4f(r, g, b, 1.0);
}
        )";
    }

private:
    float m_time = 0.0f;
};
`;
    } else if (templateType === 'Value/Modulator') {
        return `#pragma once

#include <vivid/vivid.h>

using namespace vivid;

/**
 * @brief ${name} - Custom value modulator
 *
 * Outputs scalar values that can be used to modulate
 * other operators' parameters. Similar to an LFO.
 *
 * @par Usage
 * @code
 * auto& mod = chain.add<${name}>("mod");
 * mod.frequency = 2.0f;
 *
 * // In update():
 * float value = chain.get<${name}>("mod").outputValue();
 * chain.get<Blur>("blur").radius = value * 10.0f;
 * @endcode
 */
class ${name} : public Operator {
public:
    // Parameters
    Param<float> frequency{"frequency", 1.0f, 0.01f, 20.0f};
    Param<float> amplitude{"amplitude", 1.0f, 0.0f, 2.0f};
    Param<float> offset{"offset", 0.0f, -1.0f, 1.0f};

    void init(Context& ctx) override {
        m_phase = 0.0f;
    }

    void process(Context& ctx) override {
        float t = ctx.time();
        float freq = static_cast<float>(frequency);
        float amp = static_cast<float>(amplitude);
        float off = static_cast<float>(offset);

        // Sine wave oscillator
        m_outputValue = std::sin(t * freq * 2.0f * 3.14159f) * amp + off;
    }

    void cleanup() override {}

    std::string name() const override { return "${name}"; }

    // Value output
    OutputKind outputKind() const override { return OutputKind::Value; }

    /**
     * @brief Get the current output value
     * @return Value in range [offset - amplitude, offset + amplitude]
     */
    float outputValue() const { return m_outputValue; }

private:
    float m_phase = 0.0f;
    float m_outputValue = 0.0f;
};
`;
    } else if (templateType === 'Audio Synth') {
        return `#pragma once

#include <vivid/vivid.h>
#include <vivid/audio/audio.h>

using namespace vivid;
using namespace vivid::audio;

/**
 * @brief ${name} - Custom audio synthesizer
 *
 * Generates or processes audio samples. Requires the vivid-audio addon.
 *
 * @par Usage
 * @code
 * chain.add<${name}>("synth")
 *     .frequency(440.0f)
 *     .gain(0.5f);
 * @endcode
 */
class ${name} : public AudioOperator {
public:
    // Parameters
    Param<float> gain{"gain", 0.5f, 0.0f, 1.0f};
    Param<float> frequency{"frequency", 440.0f, 20.0f, 20000.0f};

    void initAudio(Context& ctx, uint32_t sampleRate, uint32_t bufferSize) override {
        m_sampleRate = static_cast<float>(sampleRate);
        m_phase = 0.0f;
    }

    void processAudio(Context& ctx, AudioBuffer& output) override {
        float freq = static_cast<float>(frequency);
        float g = static_cast<float>(gain);
        float phaseIncrement = freq / m_sampleRate;

        for (uint32_t i = 0; i < output.frames; i++) {
            // Simple sine wave oscillator
            float sample = std::sin(m_phase * 2.0f * 3.14159f) * g;

            output.left[i] = sample;
            output.right[i] = sample;

            m_phase += phaseIncrement;
            if (m_phase >= 1.0f) m_phase -= 1.0f;
        }
    }

    void cleanupAudio() override {}

    std::string name() const override { return "${name}"; }

private:
    float m_sampleRate = 44100.0f;
    float m_phase = 0.0f;
};
`;
    } else if (templateType === 'Audio Analyzer') {
        return `#pragma once

#include <vivid/vivid.h>
#include <vivid/audio/audio_analyzer.h>
#include <cmath>

using namespace vivid;
using namespace vivid::audio;

/**
 * @brief ${name} - Custom audio analyzer
 *
 * Extracts values from audio for visual modulation.
 * Connect to an audio source with input().
 *
 * @par Usage
 * @code
 * chain.add<Synth>("audio");
 * chain.add<${name}>("analyzer").input("audio");
 *
 * // In update():
 * float level = chain.get<${name}>("analyzer").rms();
 * chain.get<Blur>("blur").radius = level * 20.0f;
 * @endcode
 */
class ${name} : public AudioAnalyzer {
public:
    // Parameters
    Param<float> smoothing{"smoothing", 0.9f, 0.0f, 0.99f};

    ${name}() {
        registerParam(smoothing);
    }

    /**
     * @brief Get RMS (root mean square) level
     * @return Value in range [0, 1]
     */
    float rms() const { return m_rms; }

    /**
     * @brief Get peak level
     * @return Value in range [0, 1]
     */
    float peak() const { return m_peak; }

    std::string name() const override { return "${name}"; }

protected:
    void initAnalyzer(Context& ctx) override {
        m_rms = 0.0f;
        m_peak = 0.0f;
    }

    void analyze(const float* input, uint32_t frames, uint32_t channels) override {
        float sum = 0.0f;
        float maxVal = 0.0f;
        uint32_t totalSamples = frames * channels;

        for (uint32_t i = 0; i < totalSamples; i++) {
            float sample = std::abs(input[i]);
            sum += sample * sample;
            if (sample > maxVal) maxVal = sample;
        }

        float instantRms = std::sqrt(sum / totalSamples);
        float s = static_cast<float>(smoothing);

        // Exponential smoothing
        m_rms = m_rms * s + instantRms * (1.0f - s);
        m_peak = std::max(m_peak * s, maxVal);
    }

    void cleanupAnalyzer() override {}

private:
    float m_rms = 0.0f;
    float m_peak = 0.0f;
};
`;
    }

    // Fallback (should not reach here)
    return `// Unknown template type: ${templateType}`;
}

export function deactivate() {
    stopRuntime();
    if (hookServer) {
        hookServer.close();
        hookServer = undefined;
    }
}
