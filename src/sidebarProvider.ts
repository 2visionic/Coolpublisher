import * as vscode from 'vscode';
import { exec } from 'child_process';
import {
  FtpConfig,
  ManifestInspectionResult,
  UploadProgressReport
} from './types';
import {
  inspectWorkspaceManifest,
  scaffoldCoolPublisherInRepo,
  updateManifestFtpConfig,
  updateManifestMappingEnabled
} from './manifestService';
import { testFtpConnection, uploadBuildToFtp } from './ftpUploader';

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export class CoolPublisherSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'coolpublisher.panelView';
  private _view?: vscode.WebviewView;
  private _isUploading = false;
  private _abortSignal = { cancelled: false };
  private _lastProgress?: UploadProgressReport;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _output: vscode.OutputChannel,
    private readonly _onStateChanged: (inspection: ManifestInspectionResult) => void
  ) {}

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getSecretKey(host: string, user: string): string {
    return `coolpublisher.ftp.pass.${host.trim().toLowerCase()}.${user.trim().toLowerCase()}`;
  }

  public async hasPassword(host: string, user: string): Promise<boolean> {
    if (!host || !user) {
      return false;
    }
    const val = await this._context.secrets.get(this.getSecretKey(host, user));
    return Boolean(val && val.length > 0);
  }

  public async getPassword(host: string, user: string): Promise<string | undefined> {
    if (!host || !user) {
      return undefined;
    }
    return this._context.secrets.get(this.getSecretKey(host, user));
  }

  public async setPassword(host: string, user: string, password: string): Promise<void> {
    if (!host || !user) {
      return;
    }
    await this._context.secrets.store(this.getSecretKey(host, user), password);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(msg);
    });

    this.refresh();
  }

  public async refresh(): Promise<ManifestInspectionResult> {
    const root = this.getWorkspaceRoot();
    const inspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
    this._onStateChanged(inspection);

    // Update Activity Bar badge on the view
    if (this._view) {
      if (inspection.isReadyForUpload) {
        this._view.badge = {
          value: 1,
          tooltip: `Build "${inspection.manifest?.projectName}" je připraven pro FTP UPLOAD`
        };
      } else {
        this._view.badge = undefined;
      }
      this._view.webview.html = this.getHtmlForWebview(inspection);
    }

    return inspection;
  }

  private async handleMessage(msg: any): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage('Nejprve otevři složku projektu / repozitáře ve VS Code.');
      return;
    }

    switch (msg.type) {
      case 'refresh': {
        await this.refresh();
        break;
      }

      case 'scaffold': {
        const { manifestPath } = scaffoldCoolPublisherInRepo(root);
        const doc = await vscode.workspace.openTextDocument(manifestPath);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(
          'Vytvořen soubor coolpublisher.json a skript scripts/coolpublisher-build.mjs!'
        );
        await this.refresh();
        break;
      }

      case 'openManifest': {
        const inspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
        if (inspection.manifestPath) {
          const doc = await vscode.workspace.openTextDocument(inspection.manifestPath);
          await vscode.window.showTextDocument(doc);
        }
        break;
      }

      case 'openOutput': {
        this._output.show(true);
        break;
      }

      case 'toggleMapping': {
        const inspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
        if (inspection.manifestPath) {
          updateManifestMappingEnabled(inspection.manifestPath, msg.index, Boolean(msg.enabled));
          await this.refresh();
        }
        break;
      }

      case 'saveFtpConfig': {
        const inspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
        if (!inspection.manifestPath) {
          return;
        }
        const ftpConfig: FtpConfig = {
          host: String(msg.host || '').trim(),
          port: Number(msg.port) || 21,
          user: String(msg.user || '').trim(),
          secure: Boolean(msg.secure)
        };
        updateManifestFtpConfig(inspection.manifestPath, ftpConfig);
        if (msg.password && String(msg.password).trim().length > 0) {
          await this.setPassword(ftpConfig.host, ftpConfig.user, String(msg.password));
        }
        vscode.window.showInformationMessage('FTP konfigurace a přihlašovací údaje byly uloženy.');
        await this.refresh();
        break;
      }

      case 'testFtp': {
        const inspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
        if (!inspection.manifestPath) {
          return;
        }
        const ftpConfig: FtpConfig = {
          host: String(msg.host || '').trim(),
          port: Number(msg.port) || 21,
          user: String(msg.user || '').trim(),
          secure: Boolean(msg.secure)
        };
        updateManifestFtpConfig(inspection.manifestPath, ftpConfig);
        if (msg.password && String(msg.password).trim().length > 0) {
          await this.setPassword(ftpConfig.host, ftpConfig.user, String(msg.password));
        }

        const password = await this.getPassword(ftpConfig.host, ftpConfig.user);
        if (!password) {
          vscode.window.showWarningMessage('Zadej prosím FTP heslo před testem spojení.');
          return;
        }

        this._output.show(true);
        const res = await testFtpConnection(ftpConfig, password, this._output);
        if (res.ok) {
          vscode.window.showInformationMessage(`✅ ${res.message}`);
        } else {
          vscode.window.showErrorMessage(`❌ ${res.message}`);
        }
        await this.refresh();
        break;
      }

      case 'runBuild': {
        const inspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
        const cmd = inspection.manifest?.buildCommand || 'node scripts/coolpublisher-build.mjs';
        this._output.show(true);
        this._output.appendLine(`[Build] Spouštím příkaz: ${cmd}`);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `CoolPublisher: Spouštím build (${cmd})...`,
            cancellable: false
          },
          () =>
            new Promise<void>((resolve) => {
              const child = exec(cmd, { cwd: root });
              child.stdout?.on('data', (d) => this._output.append(d.toString()));
              child.stderr?.on('data', (d) => this._output.append(d.toString()));
              child.on('close', async (code) => {
                if (code === 0) {
                  this._output.appendLine('[Build] ✅ Build proběhl úspěšně.');
                  vscode.window.showInformationMessage('✅ Build dokončen! Projekt je připraven pro FTP Upload.');
                } else {
                  this._output.appendLine(`[Build] ❌ Build skončil s kódem ${code}.`);
                  vscode.window.showErrorMessage(`Build skončil s chybou (kód ${code}). Podívej se do výstupu.`);
                }
                await this.refresh();
                resolve();
              });
            })
        );
        break;
      }

      case 'upload': {
        const inspectionBefore = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
        if (inspectionBefore.manifestPath && msg.host && msg.user) {
          const ftpConfig: FtpConfig = {
            host: String(msg.host).trim(),
            port: Number(msg.port) || 21,
            user: String(msg.user).trim(),
            secure: Boolean(msg.secure)
          };
          updateManifestFtpConfig(inspectionBefore.manifestPath, ftpConfig);
          if (msg.password && String(msg.password).trim().length > 0) {
            await this.setPassword(ftpConfig.host, ftpConfig.user, String(msg.password));
          }
        }
        await this.startUpload(Boolean(msg.smartSync));
        break;
      }

      case 'cancelUpload': {
        this._abortSignal.cancelled = true;
        break;
      }
    }
  }

  public async startUpload(smartSync = true): Promise<void> {
    if (this._isUploading) {
      vscode.window.showInformationMessage('Upload již právě probíhá.');
      return;
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      return;
    }

    const inspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
    if (!inspection.found || !inspection.manifest) {
      vscode.window.showWarningMessage('Nebyl nalezen soubor coolpublisher.json ani publish-manifest.json.');
      return;
    }

    const ftpConfig = inspection.manifest.ftp;
    if (!ftpConfig?.host || !ftpConfig?.user) {
      vscode.window.showWarningMessage('Vyplň nejprve FTP server (host) a uživatele (user).');
      return;
    }

    let password = await this.getPassword(ftpConfig.host, ftpConfig.user);
    if (!password) {
      password = await vscode.window.showInputBox({
        prompt: `Zadej FTP heslo pro ${ftpConfig.user}@${ftpConfig.host}`,
        password: true,
        ignoreFocusOut: true
      });
      if (!password) {
        return;
      }
      await this.setPassword(ftpConfig.host, ftpConfig.user, password);
    }

    this._isUploading = true;
    this._abortSignal = { cancelled: false };
    this._output.show(true);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CoolPublisher: Nahrávám "${inspection.manifest.projectName}" na FTP...`,
        cancellable: true
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          this._abortSignal.cancelled = true;
        });

        try {
          if (inspection.manifest?.buildCommand) {
            const buildCmd = inspection.manifest.buildCommand;
            this._output.appendLine(`[Pre-Upload Build] Spouštím build příkaz: ${buildCmd}`);
            progress.report({ message: `1% – Kompiluji nejnovější změny (${buildCmd})...` });
            await new Promise<void>((resolve, reject) => {
              const child = exec(buildCmd, { cwd: root });
              child.stdout?.on('data', (d) => this._output.append(d.toString()));
              child.stderr?.on('data', (d) => this._output.append(d.toString()));
              child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Build příkaz "${buildCmd}" skončil s kódem ${code}.`));
              });
            });
          }

          const freshInspection = await inspectWorkspaceManifest(root, (h, u) => this.hasPassword(h, u));
          const result = await uploadBuildToFtp({
            workspaceRoot: root,
            ftpConfig,
            password: password!,
            mappings: freshInspection.mappings,
            smartSync,
            output: this._output,
            abortSignal: this._abortSignal,
            onProgress: (report) => {
              this._lastProgress = report;
              progress.report({ message: `${report.percent}% – ${report.message}` });
              if (this._view) {
                this._view.webview.postMessage({
                  type: 'uploadProgress',
                  report
                });
              }
            }
          });

          if (result.success) {
            vscode.window.showInformationMessage(
              `🚀 FTP Upload dokončen! Nahráno: ${result.uploadedCount} souborů, přeskočeno (beze změny): ${result.skippedCount}.`
            );
          } else {
            vscode.window.showErrorMessage(`❌ FTP Upload selhal: ${result.errorMessage}`);
          }
        } catch (err: any) {
          const msg = err?.message || String(err);
          this._output.appendLine(`[CoolPublisher] ❌ Neočekávaná chyba uploadu: ${msg}`);
          vscode.window.showErrorMessage(`❌ FTP Upload selhal: ${msg}`);
        } finally {
          this._isUploading = false;
          await this.refresh();
        }
      }
    );
  }

  private getHtmlForWebview(inspection: ManifestInspectionResult): string {
    if (!inspection.workspaceRoot) {
      return this.wrapHtml(`
        <div class="card empty">
          <h3>Žádná otevřená složka</h3>
          <p>Otevři ve VS Code jakýkoliv svůj repozitář.</p>
        </div>
      `);
    }

    if (!inspection.found) {
      return this.wrapHtml(`
        <div class="status-banner neutral">
          <span class="dot"></span>
          <div>
            <strong>Manifest buildu nenalezen</strong>
            <div class="sub">Hledám <code>coolpublisher.json</code> nebo <code>publish-manifest.json</code></div>
          </div>
        </div>
        <div class="card">
          <p>Tento repozitář zatím nemá konfigurační JSON pro CoolPublisher.</p>
          <p class="muted">Jedním klikem vytvoříš šablonu <code>coolpublisher.json</code> (React Web + Backoffice + PHP API pro InfinityFree) a build skript:</p>
          <button class="btn primary" onclick="send('scaffold')">✨ Inicializovat CoolPublisher v tomto repu</button>
        </div>
      `);
    }

    if (inspection.parseError || !inspection.manifest) {
      return this.wrapHtml(`
        <div class="status-banner error">
          <span class="dot"></span>
          <div>
            <strong>Chyba v ${inspection.manifestFileName}</strong>
            <div class="sub">${inspection.parseError}</div>
          </div>
        </div>
        <button class="btn secondary" onclick="send('openManifest')">📝 Otevřít a opravit JSON</button>
      `);
    }

    const m = inspection.manifest;
    const builtDate = m.builtAt ? new Date(m.builtAt).toLocaleString('cs-CZ') : 'Zatím nespuštěno';

    const statusBanner = inspection.isReadyForUpload
      ? `
        <div class="status-banner ready">
          <span class="dot"></span>
          <div class="banner-text">
            <strong>PŘIPRAVENO PRO FTP UPLOAD</strong>
            <div class="sub">${inspection.totalFilesToUpload} souborů (${formatBytes(inspection.totalBytesToUpload)}) čeká na nahrání</div>
          </div>
        </div>
      `
      : `
        <div class="status-banner warning">
          <span class="dot"></span>
          <div class="banner-text">
            <strong>BUILD NENÍ KOMPLETNÍ / PŘIPRAVEN</strong>
            <div class="sub">Některá složka buildu neexistuje nebo je prázdná. Spusť nejprve Build.</div>
          </div>
        </div>
      `;

    const mappingsHtml = inspection.mappings
      .map((item) => {
        const pillClass = item.ready ? 'pill-ok' : 'pill-missing';
        const pillIcon = item.ready ? 'check_circle' : 'error';
        const statusText = item.ready
          ? `${item.fileCount} soub. • ${formatBytes(item.totalBytes)}`
          : `Chybí build složka`;

        return `
          <div class="mapping-item ${item.enabled ? '' : 'disabled'}" id="mapping-card-${item.index}">
            <div class="mapping-header" onclick="toggleExpand(${item.index}, event)">
              <label class="checkbox-label" onclick="event.stopPropagation()">
                <input type="checkbox" ${item.enabled ? 'checked' : ''} onchange="toggleMapping(${item.index}, this.checked)" />
                <span class="mapping-title">${item.name}</span>
              </label>
              <button type="button" class="expand-btn" title="Rozbalit / zabalit detail">
                <span class="material-symbols-rounded chevron" id="chevron-${item.index}">expand_more</span>
              </button>
            </div>

            <div class="mapping-details" id="details-${item.index}">
              <div class="pill-row">
                <span class="pill ${pillClass}">
                  <span class="material-symbols-rounded pill-icon">${pillIcon}</span>
                  <span>${statusText}</span>
                </span>
              </div>

              <div class="path-stack">
                <div class="path-box" title="Lokální složka">
                  <span class="material-symbols-rounded path-icon">folder_open</span>
                  <code>${item.localPath}</code>
                </div>
                <div class="path-arrow">
                  <span class="material-symbols-rounded">arrow_downward</span>
                </div>
                <div class="path-box" title="Cílová složka na FTP">
                  <span class="material-symbols-rounded path-icon">cloud_done</span>
                  <code>${item.remotePath}</code>
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    const ftp = m.ftp || { host: 'ftpupload.net', port: 21, user: '' };
    const passBadge = inspection.hasStoredPassword
      ? `<span class="pill pill-ok"><span class="material-symbols-rounded pill-icon">lock</span><span>Trezor OK</span></span>`
      : `<span class="pill pill-missing"><span class="material-symbols-rounded pill-icon">warning</span><span>Bez hesla</span></span>`;

    return this.wrapHtml(`
      ${statusBanner}

      <!-- 1. Box Build (Tlačítko Build + Čtvercové tlačítko Settings + Čas posledního buildu) -->
      <div class="card">
        <div class="build-action-row">
          <button type="button" class="btn secondary build-main-btn" onclick="send('runBuild')">
            <span class="material-symbols-rounded">build</span>
            <span>Build</span>
          </button>
          <button type="button" class="icon-square-btn" onclick="send('openManifest')" title="Otevřít ${inspection.manifestFileName}">
            <span class="material-symbols-rounded">settings</span>
          </button>
        </div>
        <div class="build-time-row">
          <span class="material-symbols-rounded time-icon">schedule</span>
          <span>Poslední build: <strong>${builtDate}</strong></span>
        </div>
      </div>

      <!-- 2. Box Publikace na FTP (hned pod sekcí Build) -->
      <div class="card highlight-card">
        <div id="progressBox" class="progress-box" style="display: ${this._isUploading ? 'block' : 'none'};">
          <div class="progress-bar-bg">
            <div id="progressBarFill" class="progress-bar-fill" style="width: ${this._lastProgress?.percent || 0}%;"></div>
          </div>
          <div id="progressText" class="progress-text">${this._lastProgress?.message || 'Připravuji...'}</div>
          <button type="button" class="btn danger" style="margin-top:8px;" onclick="send('cancelUpload')">
            <span class="material-symbols-rounded">stop_circle</span>
            <span>Zrušit upload</span>
          </button>
        </div>

        <button
          type="button"
          id="uploadBtn"
          class="btn primary big-btn"
          ${!inspection.allEnabledMappingsReady || this._isUploading ? 'disabled' : ''}
          onclick="triggerUpload()"
        >
          <span class="material-symbols-rounded">cloud_upload</span>
          <span>Upload</span>
        </button>

        <label class="checkbox-label sync-checkbox">
          <input type="checkbox" id="smartSync" checked />
          <span>Nahrát jen změněné soubory</span>
        </label>
      </div>

      <!-- 3. Box Struktury (Rozbalovací položky, ve výchozím stavu sbalené jen na checkbox a název) -->
      <div class="card">
        <div class="card-title-row">
          <div class="section-heading">
            <span class="material-symbols-rounded section-icon">account_tree</span>
            <h3>Struktura</h3>
          </div>
          <button type="button" class="icon-mini-btn" onclick="send('refresh')" title="Obnovit stav složek">
            <span class="material-symbols-rounded">refresh</span>
          </button>
        </div>
        <div class="mappings-list">
          ${mappingsHtml}
        </div>
      </div>

      <!-- 4. Box FTP Autorizace (Sladěný vizuál + Material Symbols) -->
      <div class="card">
        <div class="card-title-row">
          <div class="section-heading">
            <span class="material-symbols-rounded section-icon">vpn_key</span>
            <h3>FTP Autorizace</h3>
          </div>
          ${passBadge}
        </div>

        <div class="form-group">
          <label>
            <span class="material-symbols-rounded field-icon">dns</span>
            <span>FTP Server (Host)</span>
          </label>
          <input type="text" id="ftpHost" value="${ftp.host || 'ftpupload.net'}" placeholder="ftpupload.net" />
        </div>

        <div class="form-row">
          <div class="form-group" style="flex:2;">
            <label>
              <span class="material-symbols-rounded field-icon">person</span>
              <span>Uživatel (Login)</span>
            </label>
            <input type="text" id="ftpUser" value="${ftp.user || ''}" placeholder="if0_37xxxxxx" />
          </div>
          <div class="form-group" style="flex:1;">
            <label>
              <span class="material-symbols-rounded field-icon">lan</span>
              <span>Port</span>
            </label>
            <input type="number" id="ftpPort" value="${ftp.port || 21}" />
          </div>
        </div>

        <div class="form-group">
          <label>
            <span class="material-symbols-rounded field-icon">password</span>
            <span>FTP Heslo ${inspection.hasStoredPassword ? '(vyplň jen pro změnu)' : ''}</span>
          </label>
          <input type="password" id="ftpPassword" placeholder="${inspection.hasStoredPassword ? '••••••••••••' : 'Zadej FTP heslo'}" />
        </div>

        <label class="checkbox-label" style="margin: 8px 0 12px 0;">
          <input type="checkbox" id="ftpSecure" ${ftp.secure !== false ? 'checked' : ''} />
          <span>Explicit FTPS (TLS šifrování)</span>
        </label>

        <div class="btn-row">
          <button type="button" class="btn secondary" onclick="saveFtp()">
            <span class="material-symbols-rounded">save</span>
            <span>Uložit</span>
          </button>
          <button type="button" class="btn secondary" onclick="testFtp()">
            <span class="material-symbols-rounded">wifi_tethering</span>
            <span>Otestovat</span>
          </button>
        </div>
      </div>
    `);
  }

  private wrapHtml(bodyContent: string): string {
    return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet">
  <style>
    :root {
      --radius: 10px;
      --radius-sm: 7px;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 12px;
      margin: 0;
    }
    .material-symbols-rounded {
      font-family: 'Material Symbols Rounded';
      font-weight: normal;
      font-style: normal;
      font-size: 18px;
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      word-wrap: normal;
      direction: ltr;
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    h3 {
      margin: 0;
      font-size: 12.5px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    p {
      margin: 6px 0;
      line-height: 1.4;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
      font-size: 11.5px;
    }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 5px;
      word-break: break-all;
    }
    .status-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 12px;
      border-radius: var(--radius);
      margin-bottom: 12px;
      border: 1px solid var(--vscode-widget-border);
    }
    .status-banner.ready {
      background: rgba(34, 197, 94, 0.12);
      border-color: rgba(34, 197, 94, 0.4);
    }
    .status-banner.warning {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.4);
    }
    .status-banner.error {
      background: rgba(239, 68, 68, 0.14);
      border-color: rgba(239, 68, 68, 0.45);
    }
    .status-banner.neutral {
      background: var(--vscode-editorWidget-background);
    }
    .status-banner .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
      background: #888;
    }
    .status-banner.ready .dot {
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
    }
    .status-banner.warning .dot {
      background: #f59e0b;
    }
    .status-banner.error .dot {
      background: #ef4444;
    }
    .status-banner .sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    .card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 12px;
    }
    .highlight-card {
      border-color: var(--vscode-focusBorder, rgba(168, 85, 247, 0.5));
    }
    .card-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .section-heading {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-icon {
      font-size: 17px;
      color: var(--vscode-textLink-foreground);
    }
    /* Box 3: Build + Settings */
    .build-action-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .build-main-btn {
      flex: 1;
      height: 36px;
    }
    .icon-square-btn {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-sm);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .icon-square-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .icon-mini-btn {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    .icon-mini-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
      color: var(--vscode-foreground);
    }
    .build-time-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 9px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .time-icon {
      font-size: 15px;
      opacity: 0.85;
    }
    /* Box 4: Struktura (Rozbalovací položky) */
    .mapping-item {
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: var(--radius-sm);
      margin-bottom: 7px;
      background: var(--vscode-editor-background);
      overflow: hidden;
      transition: border-color 0.15s ease;
    }
    .mapping-item:last-child {
      margin-bottom: 0;
    }
    .mapping-item.disabled {
      opacity: 0.55;
    }
    .mapping-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
    }
    .mapping-header:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
    }
    .mapping-title {
      font-weight: 600;
      font-size: 12px;
      line-height: 1.3;
    }
    .expand-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      padding: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .chevron {
      font-size: 18px;
      transition: transform 0.2s ease;
    }
    .mapping-item.expanded .chevron {
      transform: rotate(180deg);
    }
    .mapping-details {
      display: none;
      padding: 8px 10px 10px 10px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
      background: rgba(128, 128, 128, 0.03);
    }
    .mapping-item.expanded .mapping-details {
      display: block;
    }
    .pill-row {
      margin-bottom: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10.5px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .pill-icon {
      font-size: 13px;
    }
    .pill-ok {
      background: rgba(34, 197, 94, 0.16);
      color: #4ade80;
    }
    .pill-missing {
      background: rgba(245, 158, 11, 0.16);
      color: #fbbf24;
    }
    .path-stack {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .path-box {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
    }
    .path-icon {
      font-size: 15px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .path-arrow {
      display: flex;
      justify-content: center;
      align-items: center;
      color: var(--vscode-descriptionForeground);
      height: 14px;
    }
    .path-arrow .material-symbols-rounded {
      font-size: 15px;
    }
    /* Checkbox & Form */
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      font-size: 12px;
    }
    .sync-checkbox {
      margin-top: 10px;
      justify-content: center;
      color: var(--vscode-descriptionForeground);
      font-size: 11.5px;
    }
    .form-group {
      margin-bottom: 9px;
    }
    .form-group label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .field-icon {
      font-size: 14px;
      opacity: 0.85;
    }
    .form-row {
      display: flex;
      gap: 8px;
    }
    input[type="text"],
    input[type="password"],
    input[type="number"] {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 6px;
      font-size: 12px;
    }
    input[type="text"]:focus,
    input[type="password"]:focus,
    input[type="number"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .btn-row {
      display: flex;
      gap: 8px;
    }
    .btn {
      width: 100%;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: filter 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }
    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-widget-border, rgba(255,255,255,0.22));
    }
    .btn.primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-color: var(--vscode-widget-border, rgba(128,128,128,0.25));
    }
    .btn.secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn.danger {
      background: #dc2626;
      color: #fff;
    }
    .big-btn {
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 700;
    }
    .progress-box {
      margin-bottom: 10px;
      padding: 9px;
      border-radius: var(--radius-sm);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .progress-bar-bg {
      width: 100%;
      height: 7px;
      background: rgba(128, 128, 128, 0.25);
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: #22c55e;
      transition: width 0.2s ease;
    }
    .progress-text {
      font-size: 11px;
      margin-top: 6px;
      word-break: break-all;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  ${bodyContent}

  <script>
    const vscode = acquireVsCodeApi();
    const prevState = vscode.getState() || { expanded: {} };

    function applyExpandedState() {
      const expanded = prevState.expanded || {};
      Object.keys(expanded).forEach((idx) => {
        const card = document.getElementById('mapping-card-' + idx);
        if (card) {
          card.classList.toggle('expanded', Boolean(expanded[idx]));
        }
      });
    }
    applyExpandedState();

    function toggleExpand(index, ev) {
      const card = document.getElementById('mapping-card-' + index);
      if (!card) return;
      const isExp = card.classList.toggle('expanded');
      prevState.expanded = prevState.expanded || {};
      prevState.expanded[index] = isExp;
      vscode.setState(prevState);
    }

    function send(type, payload = {}) {
      vscode.postMessage({ type, ...payload });
    }

    function toggleMapping(index, enabled) {
      send('toggleMapping', { index, enabled });
    }

    function getFtpFormValues() {
      return {
        host: document.getElementById('ftpHost')?.value || '',
        user: document.getElementById('ftpUser')?.value || '',
        port: document.getElementById('ftpPort')?.value || 21,
        password: document.getElementById('ftpPassword')?.value || '',
        secure: document.getElementById('ftpSecure')?.checked ?? true
      };
    }

    function saveFtp() {
      send('saveFtpConfig', getFtpFormValues());
    }

    function testFtp() {
      send('testFtp', getFtpFormValues());
    }

    function triggerUpload() {
      const smartSync = document.getElementById('smartSync')?.checked ?? true;
      send('upload', { smartSync, ...getFtpFormValues() });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'uploadProgress' && msg.report) {
        const box = document.getElementById('progressBox');
        const fill = document.getElementById('progressBarFill');
        const text = document.getElementById('progressText');
        const btn = document.getElementById('uploadBtn');
        if (box) box.style.display = 'block';
        if (fill) fill.style.width = (msg.report.percent || 0) + '%';
        if (text) text.textContent = msg.report.message;
        if (btn) btn.disabled = msg.report.phase !== 'done' && msg.report.phase !== 'error';
      }
    });
  </script>
</body>
</html>`;
  }
}
