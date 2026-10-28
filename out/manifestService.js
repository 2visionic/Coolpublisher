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
exports.scaffoldCoolPublisherInRepo = exports.updateManifestMappingEnabled = exports.updateManifestFtpConfig = exports.inspectWorkspaceManifest = exports.collectLocalFiles = exports.shouldExclude = exports.findManifestPath = exports.MANIFEST_FILENAMES = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.MANIFEST_FILENAMES = ['coolpublisher.json', 'publish-manifest.json'];
const DEFAULT_EXCLUDES = [
    '.git',
    '.vscode',
    'node_modules',
    '.DS_Store',
    'Thumbs.db',
    '.env.local',
    '.env.development',
    'coolpublisher.json',
    'publish-manifest.json',
    '.coolpublisher-sync-cache.json'
];
function findManifestPath(workspaceRoot) {
    for (const name of exports.MANIFEST_FILENAMES) {
        const candidate = path.join(workspaceRoot, name);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    for (const sub of ['dist', 'build', 'deploy']) {
        for (const name of exports.MANIFEST_FILENAMES) {
            const candidate = path.join(workspaceRoot, sub, name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}
exports.findManifestPath = findManifestPath;
function shouldExclude(relPathPosix, basename, customExcludes = []) {
    const allExcludes = [...DEFAULT_EXCLUDES, ...customExcludes];
    for (const pattern of allExcludes) {
        const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
        if (clean.endsWith('/**')) {
            const prefix = clean.slice(0, -3);
            if (relPathPosix === prefix || relPathPosix.startsWith(prefix + '/')) {
                return true;
            }
        }
        else if (clean.startsWith('*.')) {
            const ext = clean.slice(1);
            if (basename.endsWith(ext)) {
                return true;
            }
        }
        else {
            if (basename === clean ||
                relPathPosix === clean ||
                relPathPosix.startsWith(clean + '/') ||
                relPathPosix.includes('/' + clean + '/')) {
                return true;
            }
        }
    }
    return false;
}
exports.shouldExclude = shouldExclude;
function collectLocalFiles(rootDir, customExcludes = []) {
    const results = [];
    if (!fs.existsSync(rootDir)) {
        return results;
    }
    const stat = fs.statSync(rootDir);
    if (stat.isFile()) {
        results.push({
            absPath: rootDir,
            relPathPosix: path.basename(rootDir),
            size: stat.size
        });
        return results;
    }
    function walk(currentDir) {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
            if (shouldExclude(relPath, entry.name, customExcludes)) {
                continue;
            }
            if (entry.isDirectory()) {
                walk(fullPath);
            }
            else if (entry.isFile()) {
                try {
                    const fstat = fs.statSync(fullPath);
                    results.push({
                        absPath: fullPath,
                        relPathPosix: relPath,
                        size: fstat.size
                    });
                }
                catch {
                    // Ignore unreadable file
                }
            }
        }
    }
    walk(rootDir);
    return results;
}
exports.collectLocalFiles = collectLocalFiles;
function inspectWorkspaceManifest(workspaceRoot, hasStoredPasswordFn) {
    return (async () => {
        if (!workspaceRoot) {
            return {
                found: false,
                mappings: [],
                allEnabledMappingsReady: false,
                isReadyForUpload: false,
                totalFilesToUpload: 0,
                totalBytesToUpload: 0,
                hasStoredPassword: false
            };
        }
        const manifestPath = findManifestPath(workspaceRoot);
        if (!manifestPath) {
            return {
                found: false,
                workspaceRoot,
                mappings: [],
                allEnabledMappingsReady: false,
                isReadyForUpload: false,
                totalFilesToUpload: 0,
                totalBytesToUpload: 0,
                hasStoredPassword: false
            };
        }
        let manifest;
        try {
            const raw = fs.readFileSync(manifestPath, 'utf8');
            manifest = JSON.parse(raw);
        }
        catch (err) {
            return {
                found: true,
                workspaceRoot,
                manifestPath,
                manifestFileName: path.basename(manifestPath),
                parseError: `Chyba při čtení JSONu: ${err.message}`,
                mappings: [],
                allEnabledMappingsReady: false,
                isReadyForUpload: false,
                totalFilesToUpload: 0,
                totalBytesToUpload: 0,
                hasStoredPassword: false
            };
        }
        const manifestDir = path.dirname(manifestPath);
        const rawMappings = Array.isArray(manifest.mappings) ? manifest.mappings : [];
        const mappings = rawMappings.map((m, idx) => {
            const resolvedLocalPath = path.resolve(manifestDir, m.localPath || '.');
            const exists = fs.existsSync(resolvedLocalPath);
            const exclude = Array.isArray(m.exclude) ? m.exclude : [];
            const files = exists ? collectLocalFiles(resolvedLocalPath, exclude) : [];
            const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
            const enabled = m.enabled !== false;
            const ready = exists && files.length > 0;
            return {
                index: idx,
                name: m.name || `Modul #${idx + 1}`,
                type: m.type || 'custom',
                localPath: m.localPath,
                resolvedLocalPath,
                remotePath: m.remotePath || '/htdocs',
                enabled,
                exists,
                fileCount: files.length,
                totalBytes,
                exclude,
                ready
            };
        });
        const enabledMappings = mappings.filter((m) => m.enabled);
        const allEnabledMappingsReady = enabledMappings.length > 0 && enabledMappings.every((m) => m.ready);
        const totalFilesToUpload = enabledMappings.reduce((sum, m) => sum + m.fileCount, 0);
        const totalBytesToUpload = enabledMappings.reduce((sum, m) => sum + m.totalBytes, 0);
        const host = manifest.ftp?.host || '';
        const user = manifest.ftp?.user || '';
        const hasStoredPassword = host && user ? await hasStoredPasswordFn(host, user) : false;
        const isReadyForUpload = Boolean(manifest.readyForUpload) && allEnabledMappingsReady;
        return {
            found: true,
            workspaceRoot,
            manifestPath,
            manifestFileName: path.basename(manifestPath),
            manifest,
            mappings,
            allEnabledMappingsReady,
            isReadyForUpload,
            totalFilesToUpload,
            totalBytesToUpload,
            hasStoredPassword
        };
    })();
}
exports.inspectWorkspaceManifest = inspectWorkspaceManifest;
function updateManifestFtpConfig(manifestPath, ftpConfig) {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    manifest.ftp = {
        ...manifest.ftp,
        host: ftpConfig.host.trim(),
        port: Number(ftpConfig.port) || 21,
        user: ftpConfig.user.trim(),
        secure: ftpConfig.secure !== false
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
exports.updateManifestFtpConfig = updateManifestFtpConfig;
function updateManifestMappingEnabled(manifestPath, index, enabled) {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    if (Array.isArray(manifest.mappings) && manifest.mappings[index]) {
        manifest.mappings[index].enabled = enabled;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }
}
exports.updateManifestMappingEnabled = updateManifestMappingEnabled;
function scaffoldCoolPublisherInRepo(workspaceRoot) {
    const projectName = path.basename(workspaceRoot);
    const manifestPath = path.join(workspaceRoot, 'coolpublisher.json');
    const sampleManifest = {
        projectName,
        version: '1.0.0',
        builtAt: new Date().toISOString(),
        readyForUpload: true,
        buildCommand: 'node scripts/coolpublisher-build.mjs',
        ftp: {
            host: 'ftpupload.net',
            port: 21,
            user: 'if0_37xxxxxx',
            secure: true,
            rejectUnauthorized: false
        },
        mappings: [
            {
                name: 'Frontend - Web (React Build)',
                type: 'react-web',
                localPath: './frontend-web/dist',
                remotePath: '/htdocs',
                enabled: true,
                exclude: ['*.map']
            },
            {
                name: 'Frontend - Backoffice (React Build)',
                type: 'react-backoffice',
                localPath: './frontend-backoffice/dist',
                remotePath: '/htdocs/backoffice',
                enabled: true,
                exclude: ['*.map']
            },
            {
                name: 'Backend - REST API (PHP)',
                type: 'php-api',
                localPath: './backend-api',
                remotePath: '/htdocs/api',
                enabled: true,
                exclude: ['.env.local', '.git/**', 'tests/**', 'composer.lock']
            }
        ]
    };
    if (!fs.existsSync(manifestPath)) {
        fs.writeFileSync(manifestPath, JSON.stringify(sampleManifest, null, 2) + '\n', 'utf8');
    }
    const scriptsDir = path.join(workspaceRoot, 'scripts');
    if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
    }
    const scriptPath = path.join(scriptsDir, 'coolpublisher-build.mjs');
    const buildScriptContent = `#!/usr/bin/env node
/**
 * CoolPublisher - Univerzální Build & Manifest Generator skript
 * Spusť: node scripts/coolpublisher-build.mjs
 * Nebo si ho přidej do package.json: "build:publish": "node scripts/coolpublisher-build.mjs"
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const rootDir = process.cwd();
const manifestPath = path.join(rootDir, 'coolpublisher.json');

if (!fs.existsSync(manifestPath)) {
  console.error('❌ Soubor coolpublisher.json nebyl nalezen v kořeni projektu.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log(\`🚀 Spouštím přípravu buildu pro projekt: \${manifest.projectName}\`);

// 1. Automatický build React složek (pokud obsahují package.json vedle dist/ nebo build/)
for (const mapping of manifest.mappings || []) {
  if (mapping.enabled === false) continue;

  const targetDir = path.resolve(rootDir, mapping.localPath);
  const parentDir = path.dirname(targetDir);
  const pkgJsonPath = path.join(parentDir, 'package.json');

  if ((mapping.type === 'react-web' || mapping.type === 'react-backoffice') && fs.existsSync(pkgJsonPath)) {
    console.log(\`📦 Buildím React modul "\${mapping.name}" v \${parentDir}...\`);
    execSync('npm run build', { cwd: parentDir, stdio: 'inherit' });
  }
}

// 2. Aktualizace časového razítka a příznaku readyForUpload v coolpublisher.json
manifest.builtAt = new Date().toISOString();
manifest.readyForUpload = true;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n', 'utf8');
console.log('✅ Build dokončen a coolpublisher.json je připraven pro FTP UPLOAD ve VS Code!');
`;
    if (!fs.existsSync(scriptPath)) {
        fs.writeFileSync(scriptPath, buildScriptContent, 'utf8');
    }
    return { manifestPath, scriptPath };
}
exports.scaffoldCoolPublisherInRepo = scaffoldCoolPublisherInRepo;
