import * as vscode from 'vscode';
import { CoolPublisherSidebarProvider } from './sidebarProvider';
import { ManifestInspectionResult } from './types';
import { scaffoldCoolPublisherInRepo } from './manifestService';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('CoolPublisher FTP');

  // Status bar item at the bottom of VS Code
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'coolpublisher.publishAll';

  const updateStatusBar = (inspection: ManifestInspectionResult) => {
    if (!inspection.found) {
      statusBar.hide();
      return;
    }

    if (inspection.isReadyForUpload) {
      statusBar.text = `$(cloud-upload) CoolPublisher: Ready (${inspection.totalFilesToUpload} soub.)`;
      statusBar.tooltip = `Projekt "${inspection.manifest?.projectName}" je připraven pro FTP UPLOAD. Klikni pro nahrání.`;
      statusBar.backgroundColor = undefined;
    } else {
      statusBar.text = `$(warning) CoolPublisher: Čeká na build`;
      statusBar.tooltip = `Manifest nalezen, ale složky buildu ještě nejsou zkompilované.`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    statusBar.show();
  };

  const sidebarProvider = new CoolPublisherSidebarProvider(context, output, updateStatusBar);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CoolPublisherSidebarProvider.viewType,
      sidebarProvider,
      {
        webviewOptions: { retainContextWhenHidden: true }
      }
    )
  );

  // Watch for coolpublisher.json / publish-manifest.json and build folder changes
  const manifestWatcher = vscode.workspace.createFileSystemWatcher(
    '**/{coolpublisher,publish-manifest}.json'
  );

  const onManifestChange = async (uri: vscode.Uri) => {
    output.appendLine(`[Watcher] Detekována změna manifestu: ${uri.fsPath}`);
    const inspection = await sidebarProvider.refresh();
    if (inspection.isReadyForUpload) {
      const action = await vscode.window.showInformationMessage(
        `CoolPublisher: Detekován připravený build "${inspection.manifest?.projectName}" (${inspection.totalFilesToUpload} souborů). Chceš ho rovnou nahrát na FTP?`,
        '🚀 Upload na FTP',
        'Později'
      );
      if (action === '🚀 Upload na FTP') {
        await sidebarProvider.startUpload(true);
      }
    }
  };

  manifestWatcher.onDidCreate(onManifestChange);
  manifestWatcher.onDidChange(onManifestChange);
  manifestWatcher.onDidDelete(() => sidebarProvider.refresh());

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('coolpublisher.refresh', () => sidebarProvider.refresh()),
    vscode.commands.registerCommand('coolpublisher.openOutput', () => output.show(true)),
    vscode.commands.registerCommand('coolpublisher.publishAll', () => sidebarProvider.startUpload(true)),
    vscode.commands.registerCommand('coolpublisher.initManifest', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('Otevři nejprve složku projektu ve VS Code.');
        return;
      }
      const { manifestPath } = scaffoldCoolPublisherInRepo(root);
      const doc = await vscode.workspace.openTextDocument(manifestPath);
      await vscode.window.showTextDocument(doc);
      await sidebarProvider.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sidebarProvider.refresh()),
    manifestWatcher,
    statusBar,
    output
  );

  // Initial check on startup
  sidebarProvider.refresh();
}

export function deactivate() {}
