"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const sidebarProvider_1 = require("./sidebarProvider");
const manifestService_1 = require("./manifestService");
function activate(context) {
    const output = vscode.window.createOutputChannel('CoolPublisher FTP');
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'coolpublisher.publishAll';
    const updateStatusBar = (inspection) => {
        if (!inspection.found) {
            statusBar.hide();
            return;
        }
        if (inspection.isReadyForUpload) {
            statusBar.text = `$(cloud-upload) CoolPublisher: Ready (${inspection.totalFilesToUpload} soub.)`;
            statusBar.tooltip = `Projekt "${inspection.manifest?.projectName}" je připraven pro FTP UPLOAD. Klikni pro nahrání.`;
            statusBar.backgroundColor = undefined;
        }
        else {
            statusBar.text = `$(warning) CoolPublisher: Čeká na build`;
            statusBar.tooltip = `Manifest nalezen, ale složky buildu ještě nejsou zkompilované.`;
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        statusBar.show();
    };
    const sidebarProvider = new sidebarProvider_1.CoolPublisherSidebarProvider(context, output, updateStatusBar);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(sidebarProvider_1.CoolPublisherSidebarProvider.viewType, sidebarProvider, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
    const manifestWatcher = vscode.workspace.createFileSystemWatcher('**/{coolpublisher,publish-manifest}.json');
    const onManifestChange = async (uri) => {
        output.appendLine(`[Watcher] Detekována změna manifestu: ${uri.fsPath}`);
        const inspection = await sidebarProvider.refresh();
        if (inspection.isReadyForUpload) {
            const action = await vscode.window.showInformationMessage(`CoolPublisher: Detekován připravený build "${inspection.manifest?.projectName}" (${inspection.totalFilesToUpload} souborů). Chceš ho rovnou nahrát na FTP?`, '🚀 Upload na FTP', 'Později');
            if (action === '🚀 Upload na FTP') {
                await sidebarProvider.startUpload(true);
            }
        }
    };
    manifestWatcher.onDidCreate(onManifestChange);
    manifestWatcher.onDidChange(onManifestChange);
    manifestWatcher.onDidDelete(() => sidebarProvider.refresh());
    context.subscriptions.push(vscode.commands.registerCommand('coolpublisher.refresh', () => sidebarProvider.refresh()), vscode.commands.registerCommand('coolpublisher.openOutput', () => output.show(true)), vscode.commands.registerCommand('coolpublisher.publishAll', () => sidebarProvider.startUpload(true)), vscode.commands.registerCommand('coolpublisher.initManifest', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            vscode.window.showWarningMessage('Otevři nejprve složku projektu ve VS Code.');
            return;
        }
        const { manifestPath } = (0, manifestService_1.scaffoldCoolPublisherInRepo)(root);
        const doc = await vscode.workspace.openTextDocument(manifestPath);
        await vscode.window.showTextDocument(doc);
        await sidebarProvider.refresh();
    }), vscode.workspace.onDidChangeWorkspaceFolders(() => sidebarProvider.refresh()), manifestWatcher, statusBar, output);
    sidebarProvider.refresh();
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
