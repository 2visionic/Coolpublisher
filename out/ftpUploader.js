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
exports.uploadBuildToFtp = exports.testFtpConnection = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const net = __importStar(require("net"));
const path = __importStar(require("path"));
const tls = __importStar(require("tls"));
const manifestService_1 = require("./manifestService");
function computeFileSha256(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}
function normalizeRemotePath(remoteBase, relPosix) {
    let base = (remoteBase || '/').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (base === '.' || base === './') {
        base = '';
    }
    const rel = relPosix.replace(/\\/g, '/').replace(/^\/+/, '');
    const combined = base ? `${base}/${rel}` : `/${rel}`;
    return combined.startsWith('/') ? combined : '/' + combined;
}
class SimpleFtpClient {
    constructor(timeoutMs = 25000) {
        this.timeoutMs = timeoutMs;
        this.socket = null;
        this.isTls = false;
        this.host = '';
        this.port = 21;
        this.rejectUnauthorized = false;
        this.buffer = '';
        this.pendingResolve = null;
        this.pendingReject = null;
        this.currentMultiLineCode = null;
        this.collectedLines = [];
    }
    attachListeners(sock) {
        sock.setEncoding('utf8');
        sock.setTimeout(this.timeoutMs);
        sock.removeAllListeners('data');
        sock.removeAllListeners('error');
        sock.removeAllListeners('timeout');
        sock.on('data', (chunk) => {
            this.buffer += chunk;
            this.processBuffer();
        });
        sock.on('error', (err) => {
            if (this.pendingReject) {
                const rej = this.pendingReject;
                this.pendingResolve = null;
                this.pendingReject = null;
                rej(err);
            }
        });
        sock.on('timeout', () => {
            if (this.pendingReject) {
                const rej = this.pendingReject;
                this.pendingResolve = null;
                this.pendingReject = null;
                rej(new Error('FTP spojení vypršelo (timeout).'));
            }
        });
    }
    processBuffer() {
        while (true) {
            const idx = this.buffer.indexOf('\n');
            if (idx === -1) {
                break;
            }
            const line = this.buffer.slice(0, idx).replace(/\r$/, '');
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) {
                continue;
            }
            this.collectedLines.push(line);
            const m = line.match(/^(\d{3})([ -])(.*)$/);
            if (m) {
                const code = parseInt(m[1], 10);
                const sep = m[2];
                if (sep === '-') {
                    if (this.currentMultiLineCode === null) {
                        this.currentMultiLineCode = code;
                    }
                }
                else if (sep === ' ') {
                    if (this.currentMultiLineCode === null || this.currentMultiLineCode === code) {
                        const fullText = this.collectedLines.join('\n');
                        this.collectedLines = [];
                        this.currentMultiLineCode = null;
                        if (this.pendingResolve) {
                            const res = this.pendingResolve;
                            this.pendingResolve = null;
                            this.pendingReject = null;
                            res({ code, text: fullText });
                        }
                    }
                }
            }
        }
    }
    waitForReply() {
        return new Promise((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingReject = reject;
            this.processBuffer();
        });
    }
    async sendCommand(cmd, expectedCodes) {
        if (!this.socket) {
            throw new Error('FTP socket není připojen.');
        }
        const replyPromise = this.waitForReply();
        this.socket.write(cmd + '\r\n');
        const res = await replyPromise;
        if (expectedCodes && !expectedCodes.includes(res.code)) {
            throw new Error(`FTP příkaz "${cmd.startsWith('PASS ') ? 'PASS ***' : cmd}" selhal: ${res.text}`);
        }
        return res;
    }
    async connect(config, password) {
        this.host = config.host;
        this.port = config.port || 21;
        this.rejectUnauthorized = config.rejectUnauthorized ?? false;
        const rawSocket = new net.Socket();
        this.socket = rawSocket;
        this.attachListeners(rawSocket);
        const greetingPromise = this.waitForReply();
        await new Promise((resolve, reject) => {
            rawSocket.once('error', reject);
            rawSocket.connect(this.port, this.host, () => resolve());
        });
        const greeting = await greetingPromise;
        if (greeting.code !== 220) {
            throw new Error(`Neočekávaná odpověď FTP serveru: ${greeting.text}`);
        }
        if (config.secure !== false) {
            try {
                const authRes = await this.sendCommand('AUTH TLS');
                if (authRes.code === 234) {
                    rawSocket.removeAllListeners('data');
                    const tlsSocket = tls.connect({
                        socket: rawSocket,
                        host: this.host,
                        servername: this.host,
                        rejectUnauthorized: this.rejectUnauthorized
                    });
                    await new Promise((resolve, reject) => {
                        tlsSocket.once('secureConnect', () => resolve());
                        tlsSocket.once('error', reject);
                    });
                    this.socket = tlsSocket;
                    this.isTls = true;
                    this.attachListeners(tlsSocket);
                    await this.sendCommand('PBSZ 0', [200]);
                    await this.sendCommand('PROT P', [200]);
                }
            }
            catch {
                this.isTls = false;
            }
        }
        const userRes = await this.sendCommand(`USER ${config.user}`, [230, 331]);
        if (userRes.code === 331) {
            await this.sendCommand(`PASS ${password}`, [230, 202]);
        }
        await this.sendCommand('TYPE I', [200]);
        try {
            await this.sendCommand('OPTS UTF8 ON');
        }
        catch {
            // Optional command
        }
    }
    async pwd() {
        const res = await this.sendCommand('PWD', [257]);
        const m = res.text.match(/"([^"]+)"/);
        return m ? m[1] : res.text;
    }
    async ensureDir(remoteDirPath) {
        const clean = remoteDirPath.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!clean || clean === '/') {
            await this.sendCommand('CWD /', [250]);
            return;
        }
        const parts = clean.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            const cwdRes = await this.sendCommand(`CWD ${current}`);
            if (cwdRes.code !== 250) {
                await this.sendCommand(`MKD ${current}`, [257, 250, 550]);
                await this.sendCommand(`CWD ${current}`, [250]);
            }
        }
    }
    async cd(remoteDirPath) {
        await this.sendCommand(`CWD ${remoteDirPath}`, [250]);
    }
    async openPassiveDataSocket() {
        const pasvRes = await this.sendCommand('PASV', [227]);
        const m = pasvRes.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
        if (!m) {
            throw new Error(`Nelze parsovat PASV odpověď: ${pasvRes.text}`);
        }
        const p1 = parseInt(m[5], 10);
        const p2 = parseInt(m[6], 10);
        const dataPort = p1 * 256 + p2;
        const rawData = new net.Socket();
        rawData.setTimeout(this.timeoutMs);
        await new Promise((resolve, reject) => {
            rawData.once('error', reject);
            rawData.connect(dataPort, this.host, () => resolve());
        });
        return rawData;
    }
    async uploadFile(localFilePath, remoteFileName) {
        const rawDataSocket = await this.openPassiveDataSocket();
        const storReplyPromise = this.waitForReply();
        this.socket.write(`STOR ${remoteFileName}\r\n`);
        const prelim = await storReplyPromise;
        if (prelim.code !== 150 && prelim.code !== 125) {
            rawDataSocket.destroy();
            throw new Error(`FTP STOR "${remoteFileName}" odmítnut: ${prelim.text}`);
        }
        const transferDonePromise = this.waitForReply();
        const fileBuffer = fs.readFileSync(localFilePath);
        if (this.isTls && this.socket instanceof tls.TLSSocket) {
            const tlsDataSocket = tls.connect({
                socket: rawDataSocket,
                host: this.host,
                servername: this.host,
                rejectUnauthorized: this.rejectUnauthorized,
                session: this.socket.getSession()
            });
            await new Promise((resolve, reject) => {
                tlsDataSocket.once('secureConnect', () => {
                    tlsDataSocket.end(fileBuffer, () => resolve());
                });
                tlsDataSocket.once('error', reject);
            });
        }
        else {
            await new Promise((resolve, reject) => {
                rawDataSocket.once('error', reject);
                rawDataSocket.end(fileBuffer, () => resolve());
            });
        }
        const finalReply = await transferDonePromise;
        if (finalReply.code !== 226 && finalReply.code !== 250) {
            throw new Error(`FTP přenos "${remoteFileName}" nebyl potvrzen: ${finalReply.text}`);
        }
    }
    close() {
        try {
            if (this.socket) {
                this.socket.end('QUIT\r\n');
                this.socket.destroy();
            }
        }
        catch {
            // Ignore
        }
        this.socket = null;
    }
}
async function testFtpConnection(ftpConfig, password, output) {
    const client = new SimpleFtpClient(20000);
    try {
        output.appendLine(`[FTP Test] Připojuji se k ${ftpConfig.host}:${ftpConfig.port || 21} jako ${ftpConfig.user}...`);
        await client.connect(ftpConfig, password);
        const pwd = await client.pwd();
        output.appendLine(`[FTP Test] ✅ Spojení úspěšné! Aktuální adresář na FTP: ${pwd}.`);
        client.close();
        return {
            ok: true,
            message: `Spojení na ${ftpConfig.host} úspěšné (výchozí adresář: ${pwd}).`
        };
    }
    catch (err) {
        client.close();
        output.appendLine(`[FTP Test] ❌ Chyba připojení: ${err.message}`);
        return {
            ok: false,
            message: `Chyba připojení k FTP: ${err.message}`
        };
    }
}
exports.testFtpConnection = testFtpConnection;
async function uploadBuildToFtp(options) {
    const { workspaceRoot, ftpConfig, password, mappings, smartSync, output, onProgress, abortSignal } = options;
    const enabledMappings = mappings.filter((m) => m.enabled);
    if (enabledMappings.length === 0) {
        return {
            success: false,
            uploadedCount: 0,
            skippedCount: 0,
            errorMessage: 'Není vybrán žádný modul k nahrání.'
        };
    }
    onProgress({
        phase: 'scanning',
        message: 'Skenuji lokální soubory buildu a počítám kontrolní součty...',
        uploadedFiles: 0,
        skippedFiles: 0,
        totalFiles: 0,
        percent: 2
    });
    const cacheFile = path.join(workspaceRoot, '.git', 'coolpublisher-sync-cache.json');
    const fallbackCacheFile = path.join(workspaceRoot, '.coolpublisher-sync-cache.json');
    const activeCachePath = fs.existsSync(path.join(workspaceRoot, '.git'))
        ? cacheFile
        : fallbackCacheFile;
    let syncState = {};
    const hostKey = `${ftpConfig.host}_${ftpConfig.user}`;
    if (smartSync && fs.existsSync(activeCachePath)) {
        try {
            const rawCache = JSON.parse(fs.readFileSync(activeCachePath, 'utf8'));
            syncState = rawCache[hostKey] || {};
        }
        catch {
            syncState = {};
        }
    }
    const queue = [];
    let skippedCount = 0;
    for (const mapping of enabledMappings) {
        const localFiles = (0, manifestService_1.collectLocalFiles)(mapping.resolvedLocalPath, mapping.exclude);
        for (const lf of localFiles) {
            const remoteFilePath = normalizeRemotePath(mapping.remotePath, lf.relPathPosix);
            const remoteDirPath = path.posix.dirname(remoteFilePath);
            const sha256 = computeFileSha256(lf.absPath);
            if (smartSync && syncState[remoteFilePath] === sha256) {
                skippedCount++;
                continue;
            }
            queue.push({
                mappingName: mapping.name,
                localFile: lf,
                remoteFilePath,
                remoteDirPath,
                sha256
            });
        }
    }
    const totalCandidates = queue.length + skippedCount;
    output.appendLine('============================================================');
    output.appendLine(`[CoolPublisher] Start FTP Uploadu na ${ftpConfig.host}`);
    output.appendLine(`[CoolPublisher] Celkem souborů v buildu: ${totalCandidates} | K nahrání: ${queue.length} | Přeskočeno (beze změny): ${skippedCount}`);
    if (queue.length === 0) {
        onProgress({
            phase: 'done',
            message: `Všech ${skippedCount} souborů je již na FTP aktuálních (Smart Sync).`,
            uploadedFiles: 0,
            skippedFiles: skippedCount,
            totalFiles: totalCandidates,
            percent: 100
        });
        output.appendLine('[CoolPublisher] ✅ Žádné soubory se nezměnily, FTP je již aktuální.');
        return {
            success: true,
            uploadedCount: 0,
            skippedCount
        };
    }
    onProgress({
        phase: 'connecting',
        message: `Připojuji se k FTP serveru ${ftpConfig.host}...`,
        uploadedFiles: 0,
        skippedFiles: skippedCount,
        totalFiles: queue.length,
        percent: 5
    });
    const client = new SimpleFtpClient(30000);
    let uploadedCount = 0;
    const saveSyncCache = () => {
        try {
            let fullCache = {};
            if (fs.existsSync(activeCachePath)) {
                fullCache = JSON.parse(fs.readFileSync(activeCachePath, 'utf8'));
            }
            fullCache[hostKey] = syncState;
            fs.writeFileSync(activeCachePath, JSON.stringify(fullCache, null, 2), 'utf8');
        }
        catch {
            // Ignore cache write errors
        }
    };
    try {
        await client.connect(ftpConfig, password);
        output.appendLine(`[CoolPublisher] ✅ Připojeno k ${ftpConfig.host}. Zahajuji sekvenční upload...`);
        const ensuredDirs = new Set();
        let currentRemoteDir = '';
        for (let i = 0; i < queue.length; i++) {
            if (abortSignal?.cancelled) {
                throw new Error('Upload byl zrušen uživatelem.');
            }
            const item = queue[i];
            const pct = Math.min(99, Math.round(((i + 1) / queue.length) * 90) + 8);
            onProgress({
                phase: 'uploading',
                message: `Nahrávám (${i + 1}/${queue.length}): ${item.remoteFilePath}`,
                currentMapping: item.mappingName,
                currentFile: item.remoteFilePath,
                uploadedFiles: uploadedCount,
                skippedFiles: skippedCount,
                totalFiles: queue.length,
                percent: pct
            });
            if (!ensuredDirs.has(item.remoteDirPath)) {
                await client.ensureDir(item.remoteDirPath);
                ensuredDirs.add(item.remoteDirPath);
                currentRemoteDir = item.remoteDirPath;
            }
            else if (currentRemoteDir !== item.remoteDirPath) {
                await client.cd(item.remoteDirPath);
                currentRemoteDir = item.remoteDirPath;
            }
            const remoteFileName = path.posix.basename(item.remoteFilePath);
            await client.uploadFile(item.localFile.absPath, remoteFileName);
            uploadedCount++;
            syncState[item.remoteFilePath] = item.sha256;
            output.appendLine(`  [OK] ${item.localFile.relPathPosix} -> ${item.remoteFilePath}`);
        }
        saveSyncCache();
        client.close();
        onProgress({
            phase: 'done',
            message: `Hotovo! Nahráno ${uploadedCount} souborů (${skippedCount} beze změny přeskočeno).`,
            uploadedFiles: uploadedCount,
            skippedFiles: skippedCount,
            totalFiles: queue.length,
            percent: 100
        });
        output.appendLine(`[CoolPublisher] 🎉 UPLOAD DOKONČEN! Nahráno: ${uploadedCount}, Přeskočeno: ${skippedCount}.`);
        return {
            success: true,
            uploadedCount,
            skippedCount
        };
    }
    catch (err) {
        saveSyncCache();
        client.close();
        const errorMessage = err?.message || String(err);
        output.appendLine(`[CoolPublisher] ❌ CHYBA UPLOADU: ${errorMessage}`);
        onProgress({
            phase: 'error',
            message: `Chyba při nahrávání: ${errorMessage}`,
            uploadedFiles: uploadedCount,
            skippedFiles: skippedCount,
            totalFiles: queue.length,
            percent: 0
        });
        return {
            success: false,
            uploadedCount,
            skippedCount,
            errorMessage
        };
    }
}
exports.uploadBuildToFtp = uploadBuildToFtp;
