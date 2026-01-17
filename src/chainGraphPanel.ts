import * as vscode from 'vscode';
import { StatusBarManager, VividState, ChainOperator, ParamInfo } from './statusBar';
import { ParamInspectorPanel } from './paramInspectorPanel';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ELK = require('elkjs/lib/elk.bundled.js');
import type { ElkNode, ElkExtendedEdge } from 'elkjs';

export type { ChainOperator, ParamInfo };

export class ChainGraphPanel {
    public static currentPanel: ChainGraphPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly statusBarManager: StatusBarManager;
    private stateSubscription: vscode.Disposable | null = null;
    private chainStructureSubscription: vscode.Disposable | null = null;
    private soloStateSubscription: vscode.Disposable | null = null;
    private operators: ChainOperator[] = [];
    private soloedOperator: string | null = null;
    private selectedOperator: string | null = null;
    private disposed = false;
    private wasConnected = false;

    public static createOrShow(extensionUri: vscode.Uri, statusBarManager: StatusBarManager) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (ChainGraphPanel.currentPanel) {
            ChainGraphPanel.currentPanel.panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'vividChainGraph',
            'Vivid Chain Graph',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        ChainGraphPanel.currentPanel = new ChainGraphPanel(panel, extensionUri, statusBarManager);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        statusBarManager: StatusBarManager
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.statusBarManager = statusBarManager;

        // Set the webview's initial HTML content
        this.panel.webview.html = this.getHtmlContent();

        // Listen for when the panel is disposed
        this.panel.onDidDispose(() => this.dispose(), null);

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'ready':
                        // Webview is ready, request chain structure
                        this.requestChainStructure();
                        break;
                    case 'soloNode':
                        this.soloNode(message.name);
                        break;
                    case 'exitSolo':
                        this.exitSolo();
                        break;
                    case 'selectNode':
                        this.selectedOperator = message.name;
                        // Notify the sidebar inspector
                        ParamInspectorPanel.getInstance()?.selectOperator(message.name);
                        this.updateWebview();
                        break;
                    case 'deselectNode':
                        this.selectedOperator = null;
                        ParamInspectorPanel.getInstance()?.selectOperator(null);
                        this.updateWebview();
                        break;
                }
            }
        );

        // Subscribe to state changes from the status bar manager
        this.stateSubscription = statusBarManager.onStateChange((state) => {
            this.handleStateChange(state);
        });

        // Subscribe to chain structure updates
        this.chainStructureSubscription = statusBarManager.onChainStructure((operators) => {
            this.operators = operators;
            this.updateWebview();
        });

        // Subscribe to solo state updates
        this.soloStateSubscription = statusBarManager.onSoloState((active, operatorName) => {
            this.soloedOperator = active ? operatorName : null;
            this.updateWebview();
        });
    }

    private handleStateChange(state: VividState) {
        if (!state.connected) {
            this.operators = [];
            this.soloedOperator = null;
            this.selectedOperator = null;
            this.params = [];
            this.wasConnected = false;
            this.updateWebview();
            return;
        }

        // Request chain structure only when first connected
        if (!this.wasConnected) {
            this.wasConnected = true;
            this.requestChainStructure();
        }
    }

    private requestChainStructure() {
        this.statusBarManager.send({ type: 'request_chain_structure' });
    }

    private async updateWebview() {
        if (this.disposed) return;

        const state = this.statusBarManager.getState();

        if (!state.connected) {
            this.panel.webview.postMessage({
                type: 'disconnected'
            });
            return;
        }

        // Use ELK to layout the graph
        const layout = await this.calculateLayout();

        this.panel.webview.postMessage({
            type: 'update',
            operators: this.operators,
            layout: layout,
            soloedOperator: this.soloedOperator,
            selectedOperator: this.selectedOperator
        });
    }

    private async calculateLayout(): Promise<{ nodes: any[], edges: any[] }> {
        if (this.operators.length === 0) {
            return { nodes: [], edges: [] };
        }

        const elk = new ELK();

        // Build operator index map
        const opIndexMap = new Map<string, number>();
        this.operators.forEach((op, index) => {
            opIndexMap.set(op.name, index);
        });

        // Create ELK graph
        const children: ElkNode[] = this.operators.map((op, index) => ({
            id: op.name,
            width: 150,
            height: 60
        }));

        const edges: ElkExtendedEdge[] = [];
        let edgeIndex = 0;

        this.operators.forEach((op) => {
            for (const inputName of op.inputs) {
                if (opIndexMap.has(inputName)) {
                    edges.push({
                        id: `e${edgeIndex++}`,
                        sources: [inputName],
                        targets: [op.name]
                    });
                }
            }
        });

        const graph: ElkNode = {
            id: 'root',
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'RIGHT',
                'elk.spacing.nodeNode': '40',
                'elk.layered.spacing.nodeNodeBetweenLayers': '80',
                'elk.edgeRouting': 'POLYLINE'
            },
            children,
            edges
        };

        try {
            const layoutResult = await elk.layout(graph);

            const layoutNodes = (layoutResult.children || []).map((node: any) => ({
                id: node.id,
                x: node.x || 0,
                y: node.y || 0,
                width: node.width || 150,
                height: node.height || 60
            }));

            const layoutEdges = (layoutResult.edges || []).map((edge: any) => {
                const sections = edge.sections || [];
                const points: { x: number, y: number }[] = [];

                for (const section of sections) {
                    if (section.startPoint) {
                        points.push(section.startPoint);
                    }
                    if (section.bendPoints) {
                        points.push(...section.bendPoints);
                    }
                    if (section.endPoint) {
                        points.push(section.endPoint);
                    }
                }

                return {
                    id: edge.id,
                    source: edge.sources?.[0] || '',
                    target: edge.targets?.[0] || '',
                    points
                };
            });

            return { nodes: layoutNodes, edges: layoutEdges };
        } catch (e) {
            console.error('ELK layout error:', e);
            // Fallback to simple grid layout
            const nodes = this.operators.map((op, index) => ({
                id: op.name,
                x: 50 + (index % 3) * 200,
                y: 50 + Math.floor(index / 3) * 100,
                width: 150,
                height: 60
            }));
            return { nodes, edges: [] };
        }
    }

    private soloNode(name: string) {
        this.statusBarManager.send({ type: 'solo_node', operator: name });
    }

    private exitSolo() {
        this.statusBarManager.send({ type: 'solo_exit' });
    }

    private dispose() {
        this.disposed = true;
        ChainGraphPanel.currentPanel = undefined;

        if (this.stateSubscription) {
            this.stateSubscription.dispose();
        }
        if (this.chainStructureSubscription) {
            this.chainStructureSubscription.dispose();
        }
        if (this.soloStateSubscription) {
            this.soloStateSubscription.dispose();
        }

        this.panel.dispose();
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
            overflow: hidden;
        }
        .container {
            width: 100vw;
            height: 100vh;
            position: relative;
        }
        .disconnected {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            color: var(--vscode-descriptionForeground);
            flex-direction: column;
            gap: 16px;
        }
        .disconnected-icon {
            font-size: 48px;
            opacity: 0.5;
        }
        #graph {
            width: 100%;
            height: 100%;
        }
        svg {
            width: 100%;
            height: 100%;
        }
        .node {
            cursor: pointer;
            transition: transform 0.1s ease;
        }
        .node:hover {
            filter: brightness(1.1);
        }
        .node-rect {
            rx: 8;
            ry: 8;
            stroke-width: 2;
        }
        .node-texture .node-rect {
            fill: rgba(147, 112, 219, 0.3);
            stroke: #9370db;
        }
        .node-audio .node-rect {
            fill: rgba(100, 149, 237, 0.3);
            stroke: #6495ed;
        }
        .node-geometry .node-rect {
            fill: rgba(60, 179, 113, 0.3);
            stroke: #3cb371;
        }
        .node-cpupixels .node-rect {
            fill: rgba(255, 165, 0, 0.3);
            stroke: #ffa500;
        }
        .node-unknown .node-rect {
            fill: rgba(128, 128, 128, 0.3);
            stroke: #808080;
        }
        .node.soloed .node-rect {
            stroke-width: 3;
            filter: drop-shadow(0 0 8px currentColor);
        }
        .node-text {
            fill: var(--vscode-foreground);
            font-size: 13px;
            font-weight: 500;
            pointer-events: none;
            text-anchor: middle;
            dominant-baseline: middle;
        }
        .node-type {
            fill: var(--vscode-descriptionForeground);
            font-size: 10px;
            pointer-events: none;
            text-anchor: middle;
            dominant-baseline: middle;
        }
        .node-icon {
            font-size: 16px;
            pointer-events: none;
            text-anchor: middle;
            dominant-baseline: middle;
        }
        .edge {
            fill: none;
            stroke: var(--vscode-editorWidget-border);
            stroke-width: 2;
            opacity: 0.6;
        }
        .edge-arrow {
            fill: var(--vscode-editorWidget-border);
            opacity: 0.6;
        }
        .toolbar {
            position: absolute;
            top: 10px;
            right: 10px;
            display: flex;
            gap: 8px;
        }
        .toolbar button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .toolbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .status {
            position: absolute;
            bottom: 10px;
            left: 10px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .legend {
            position: absolute;
            bottom: 10px;
            right: 10px;
            display: flex;
            gap: 12px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .legend-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
        }
        .legend-dot.texture { background: #9370db; }
        .legend-dot.audio { background: #6495ed; }
        .legend-dot.geometry { background: #3cb371; }
        .legend-dot.cpupixels { background: #ffa500; }
        .node.selected .node-rect {
            stroke-width: 3;
            stroke-dasharray: 5,3;
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="disconnected" class="disconnected">
            <div class="disconnected-icon">⊘</div>
            <div>Vivid not running</div>
            <div style="font-size: 12px; opacity: 0.7;">Start a Vivid project to see the chain graph</div>
        </div>
        <div id="graph" style="display: none;">
            <svg id="svg">
                <defs>
                    <marker id="arrowhead" markerWidth="10" markerHeight="7"
                            refX="9" refY="3.5" orient="auto" class="edge-arrow">
                        <polygon points="0 0, 10 3.5, 0 7" />
                    </marker>
                </defs>
                <g id="edges"></g>
                <g id="nodes"></g>
            </svg>
        </div>
        <div class="toolbar" id="toolbar" style="display: none;">
            <button id="exitSoloBtn" disabled onclick="exitSolo()">Exit Solo</button>
        </div>
        <div class="status" id="status"></div>
        <div class="legend" id="legend" style="display: none;">
            <div class="legend-item"><div class="legend-dot texture"></div>Texture</div>
            <div class="legend-item"><div class="legend-dot audio"></div>Audio</div>
            <div class="legend-item"><div class="legend-dot geometry"></div>Geometry</div>
            <div class="legend-item"><div class="legend-dot cpupixels"></div>CpuPixels</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        let operators = [];
        let layout = { nodes: [], edges: [] };
        let soloedOperator = null;
        let selectedOperator = null;

        function getNodeClass(outputType) {
            const type = (outputType || '').toLowerCase();
            if (type === 'texture') return 'node-texture';
            if (type === 'audio') return 'node-audio';
            if (type === 'geometry') return 'node-geometry';
            if (type === 'cpupixels') return 'node-cpupixels';
            return 'node-unknown';
        }

        function getIcon(outputType) {
            const type = (outputType || '').toLowerCase();
            if (type === 'texture') return '🖼';
            if (type === 'audio') return '🔊';
            if (type === 'geometry') return '🔷';
            if (type === 'cpupixels') return '📷';
            return '⬡';
        }

        function render() {
            const disconnected = document.getElementById('disconnected');
            const graph = document.getElementById('graph');
            const toolbar = document.getElementById('toolbar');
            const legend = document.getElementById('legend');
            const status = document.getElementById('status');
            const exitSoloBtn = document.getElementById('exitSoloBtn');

            if (operators.length === 0) {
                disconnected.style.display = 'flex';
                graph.style.display = 'none';
                toolbar.style.display = 'none';
                legend.style.display = 'none';
                status.textContent = '';
                return;
            }

            disconnected.style.display = 'none';
            graph.style.display = 'block';
            toolbar.style.display = 'flex';
            legend.style.display = 'flex';
            exitSoloBtn.disabled = !soloedOperator;

            // Build operator map
            const opMap = new Map();
            operators.forEach(op => opMap.set(op.name, op));

            // Build node position map
            const nodeMap = new Map();
            layout.nodes.forEach(node => nodeMap.set(node.id, node));

            // Render edges with bezier curves
            const edgesGroup = document.getElementById('edges');
            edgesGroup.innerHTML = layout.edges.map(edge => {
                const source = nodeMap.get(edge.source);
                const target = nodeMap.get(edge.target);
                if (!source || !target) return '';

                // Start from right edge of source, end at left edge of target
                const x1 = source.x + source.width;
                const y1 = source.y + source.height / 2;
                const x2 = target.x;
                const y2 = target.y + target.height / 2;

                // Control points for smooth bezier curve
                const dx = Math.abs(x2 - x1);
                const controlOffset = Math.max(dx * 0.5, 40);
                const cx1 = x1 + controlOffset;
                const cy1 = y1;
                const cx2 = x2 - controlOffset;
                const cy2 = y2;

                const d = 'M' + x1 + ',' + y1 + ' C' + cx1 + ',' + cy1 + ' ' + cx2 + ',' + cy2 + ' ' + x2 + ',' + y2;
                return '<path class="edge" d="' + d + '" marker-end="url(#arrowhead)"/>';
            }).join('');

            // Render nodes
            const nodesGroup = document.getElementById('nodes');
            nodesGroup.innerHTML = layout.nodes.map(node => {
                const op = opMap.get(node.id);
                if (!op) return '';

                const nodeClass = getNodeClass(op.outputType);
                const icon = getIcon(op.outputType);
                const isSoloed = soloedOperator === op.name;
                const isSelected = selectedOperator === op.name;

                return '<g class="node ' + nodeClass + (isSoloed ? ' soloed' : '') + (isSelected ? ' selected' : '') + '" ' +
                       'transform="translate(' + node.x + ',' + node.y + ')" ' +
                       'onclick="selectNode(\\'' + op.name.replace(/'/g, "\\\\'") + '\\')">' +
                       '<rect class="node-rect" width="' + node.width + '" height="' + node.height + '"/>' +
                       '<text class="node-icon" x="20" y="' + (node.height / 2) + '">' + icon + '</text>' +
                       '<text class="node-text" x="' + (node.width / 2 + 10) + '" y="' + (node.height / 2 - 6) + '">' + op.name + '</text>' +
                       '<text class="node-type" x="' + (node.width / 2 + 10) + '" y="' + (node.height / 2 + 10) + '">' + op.displayName + '</text>' +
                       '</g>';
            }).join('');

            // Update status
            status.textContent = operators.length + ' operator' + (operators.length === 1 ? '' : 's');
            if (soloedOperator) {
                status.textContent += ' (solo: ' + soloedOperator + ')';
            }

            // Auto-fit the view
            fitView();
        }

        function fitView() {
            if (layout.nodes.length === 0) return;

            const svg = document.getElementById('svg');
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

            layout.nodes.forEach(node => {
                minX = Math.min(minX, node.x);
                minY = Math.min(minY, node.y);
                maxX = Math.max(maxX, node.x + node.width);
                maxY = Math.max(maxY, node.y + node.height);
            });

            const padding = 40;
            const viewBox = (minX - padding) + ' ' + (minY - padding) + ' ' +
                           (maxX - minX + padding * 2) + ' ' + (maxY - minY + padding * 2);
            svg.setAttribute('viewBox', viewBox);
        }

        function soloNode(name) {
            vscode.postMessage({ command: 'soloNode', name: name });
        }

        function exitSolo() {
            vscode.postMessage({ command: 'exitSolo' });
        }

        function selectNode(name) {
            vscode.postMessage({ command: 'selectNode', name: name });
        }

        function deselectNode() {
            vscode.postMessage({ command: 'deselectNode' });
        }

        window.addEventListener('message', event => {
            const message = event.data;

            if (message.type === 'update') {
                operators = message.operators || [];
                layout = message.layout || { nodes: [], edges: [] };
                soloedOperator = message.soloedOperator;
                selectedOperator = message.selectedOperator;
                render();
            } else if (message.type === 'disconnected') {
                operators = [];
                layout = { nodes: [], edges: [] };
                soloedOperator = null;
                selectedOperator = null;
                render();
            }
        });

        // Notify that we're ready
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
