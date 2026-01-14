import * as vscode from 'vscode';
import * as path from 'path';
import { StatusBarManager, VividState, CompileError } from './statusBar';

export class DiagnosticsManager {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private disposable: vscode.Disposable;

    constructor(statusBarManager: StatusBarManager) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('vivid');

        // Subscribe to state changes
        this.disposable = statusBarManager.onStateChange((state) => {
            this.updateDiagnostics(state);
        });
    }

    private updateDiagnostics(state: VividState) {
        // Clear all diagnostics first
        this.diagnosticCollection.clear();

        if (!state.connected) {
            return;
        }

        if (state.compileStatus?.success) {
            // Compilation succeeded - no errors to show
            return;
        }

        if (!state.compileStatus?.errors || state.compileStatus.errors.length === 0) {
            // No structured errors, but might have raw message
            if (state.compileStatus?.message) {
                // Try to find chain.cpp in workspace and add a generic error
                this.addGenericError(state.compileStatus.message);
            }
            return;
        }

        // Group errors by file
        const errorsByFile = new Map<string, CompileError[]>();
        for (const error of state.compileStatus.errors) {
            const existing = errorsByFile.get(error.file) || [];
            existing.push(error);
            errorsByFile.set(error.file, existing);
        }

        // Convert to diagnostics
        for (const [file, errors] of errorsByFile) {
            const uri = this.resolveFileUri(file);
            if (!uri) continue;

            const diagnostics = errors.map(error => this.errorToDiagnostic(error));
            this.diagnosticCollection.set(uri, diagnostics);
        }
    }

    private errorToDiagnostic(error: CompileError): vscode.Diagnostic {
        // Lines and columns are 1-based in compiler output, VS Code uses 0-based
        const line = Math.max(0, error.line - 1);
        const column = Math.max(0, error.column - 1);

        const range = new vscode.Range(
            new vscode.Position(line, column),
            new vscode.Position(line, column + 100) // Highlight to end of line
        );

        let severity: vscode.DiagnosticSeverity;
        switch (error.severity) {
            case 'error':
                severity = vscode.DiagnosticSeverity.Error;
                break;
            case 'warning':
                severity = vscode.DiagnosticSeverity.Warning;
                break;
            case 'note':
                severity = vscode.DiagnosticSeverity.Information;
                break;
            default:
                severity = vscode.DiagnosticSeverity.Error;
        }

        const diagnostic = new vscode.Diagnostic(range, error.message, severity);
        diagnostic.source = 'vivid';
        return diagnostic;
    }

    private resolveFileUri(file: string): vscode.Uri | null {
        // First try to find in workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;

        // Check if it's an absolute path
        if (path.isAbsolute(file)) {
            return vscode.Uri.file(file);
        }

        // Try to find chain.cpp in any workspace folder
        for (const folder of workspaceFolders) {
            const candidates = [
                vscode.Uri.joinPath(folder.uri, file),
                vscode.Uri.joinPath(folder.uri, 'chain.cpp'),
            ];

            for (const candidate of candidates) {
                // Return the first match - actual file existence check would require async
                if (file === 'chain.cpp' || file.endsWith('/chain.cpp')) {
                    return candidate;
                }
            }
        }

        // Default: assume it's in the first workspace folder
        return vscode.Uri.joinPath(workspaceFolders[0].uri, file);
    }

    private addGenericError(message: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        // Try to find chain.cpp
        const chainUri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'chain.cpp');

        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, 0),
            message.substring(0, 500), // Truncate very long messages
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'vivid';

        this.diagnosticCollection.set(chainUri, [diagnostic]);
    }

    dispose() {
        this.disposable.dispose();
        this.diagnosticCollection.dispose();
    }
}
