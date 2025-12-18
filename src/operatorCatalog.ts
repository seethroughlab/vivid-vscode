// Operator Catalog - loads available operators from vivid runtime

import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface OperatorParam {
    name: string;
    type: 'Float' | 'Int' | 'Bool' | 'Vec2' | 'Vec3' | 'Vec4' | 'Color' | 'String' | 'FilePath';
    default?: number | number[] | string | boolean;
    min?: number;
    max?: number;
    fileFilter?: string;
    fileCategory?: string;
}

export interface OperatorDefinition {
    name: string;
    category: string;
    description: string;
    addon: string | null;
    requiresInput: boolean;
    outputType: string;
    params: OperatorParam[];
}

interface CatalogJson {
    version: string;
    operators: OperatorDefinition[];
}

export class OperatorCatalog {
    private operators: OperatorDefinition[] = [];
    private categoriesCache: string[] = [];
    private loaded = false;
    private outputChannel: vscode.OutputChannel | undefined;

    setOutputChannel(channel: vscode.OutputChannel): void {
        this.outputChannel = channel;
    }

    private log(message: string): void {
        console.log(message);
        this.outputChannel?.appendLine(message);
    }

    /**
     * Load operator catalog from vivid runtime
     * @param runtimePath Path to vivid executable
     */
    async loadFromRuntime(runtimePath: string): Promise<boolean> {
        this.log(`[OperatorCatalog] Loading from runtime: ${runtimePath}`);

        return new Promise((resolve) => {
            const process = spawn(runtimePath, ['operators', '--json']);
            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            process.on('close', (code) => {
                if (code !== 0) {
                    this.log(`[OperatorCatalog] Error: vivid operators --json exited with code ${code}`);
                    if (stderr) {
                        this.log(`[OperatorCatalog] stderr: ${stderr}`);
                    }
                    resolve(false);
                    return;
                }

                try {
                    const json: CatalogJson = JSON.parse(stdout);
                    this.operators = json.operators;
                    this.categoriesCache = this.computeCategories();
                    this.loaded = true;
                    this.log(`[OperatorCatalog] Loaded ${this.operators.length} operators in ${this.categoriesCache.length} categories`);
                    resolve(true);
                } catch (e) {
                    this.log(`[OperatorCatalog] Error parsing JSON: ${e}`);
                    resolve(false);
                }
            });

            process.on('error', (err) => {
                this.log(`[OperatorCatalog] Error spawning process: ${err.message}`);
                resolve(false);
            });
        });
    }

    isLoaded(): boolean {
        return this.loaded;
    }

    getOperators(): OperatorDefinition[] {
        return this.operators;
    }

    private computeCategories(): string[] {
        const cats = new Set<string>();
        for (const op of this.operators) {
            cats.add(op.category);
        }
        // Return in a sensible order
        const order = ['Generators', 'Effects', 'Retro', 'Compositing', 'Particles', 'Canvas', 'Math/Logic'];
        const result: string[] = [];
        for (const cat of order) {
            if (cats.has(cat)) {
                result.push(cat);
                cats.delete(cat);
            }
        }
        // Add any remaining categories
        for (const cat of cats) {
            result.push(cat);
        }
        return result;
    }

    getCategories(): string[] {
        return this.categoriesCache;
    }

    getOperatorsByCategory(category: string): OperatorDefinition[] {
        return this.operators.filter(op => op.category === category);
    }

    getOperator(name: string): OperatorDefinition | undefined {
        return this.operators.find(op => op.name === name);
    }

    searchOperators(query: string): OperatorDefinition[] {
        const q = query.toLowerCase();
        return this.operators.filter(op =>
            op.name.toLowerCase().includes(q) ||
            op.description.toLowerCase().includes(q) ||
            op.category.toLowerCase().includes(q)
        );
    }

    /**
     * Get Quick Pick items for category selection
     */
    getCategoryQuickPickItems(): vscode.QuickPickItem[] {
        return this.categoriesCache.map(cat => {
            const count = this.getOperatorsByCategory(cat).length;
            return {
                label: cat,
                description: `${count} operator${count === 1 ? '' : 's'}`
            };
        });
    }

    /**
     * Get Quick Pick items for operator selection within a category
     */
    getOperatorQuickPickItems(category: string): vscode.QuickPickItem[] {
        return this.getOperatorsByCategory(category).map(op => ({
            label: op.name,
            description: op.description,
            detail: op.params.length > 0
                ? `Parameters: ${op.params.map(p => p.name).join(', ')}`
                : 'No parameters'
        }));
    }

    /**
     * Get all operators as Quick Pick items (flat list)
     */
    getAllOperatorQuickPickItems(): vscode.QuickPickItem[] {
        return this.operators.map(op => ({
            label: op.name,
            description: `[${op.category}] ${op.description}`,
            detail: op.params.length > 0
                ? `Parameters: ${op.params.map(p => p.name).join(', ')}`
                : 'No parameters'
        }));
    }
}
