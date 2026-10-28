export interface FtpConfig {
  host: string;
  port?: number;
  user: string;
  secure?: boolean | 'implicit';
  rejectUnauthorized?: boolean;
}

export interface PublishMapping {
  id?: string;
  name: string;
  type?: 'react-web' | 'react-backoffice' | 'php-api' | 'custom';
  localPath: string;
  remotePath: string;
  enabled?: boolean;
  exclude?: string[];
}

export interface PublishManifest {
  projectName: string;
  version?: string;
  builtAt?: string;
  readyForUpload: boolean;
  buildCommand?: string;
  ftp: FtpConfig;
  mappings: PublishMapping[];
}

export interface MappingInspection {
  index: number;
  name: string;
  type: string;
  localPath: string;
  resolvedLocalPath: string;
  remotePath: string;
  enabled: boolean;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  exclude: string[];
  ready: boolean;
}

export interface ManifestInspectionResult {
  found: boolean;
  workspaceRoot?: string;
  manifestPath?: string;
  manifestFileName?: string;
  parseError?: string;
  manifest?: PublishManifest;
  mappings: MappingInspection[];
  allEnabledMappingsReady: boolean;
  isReadyForUpload: boolean;
  totalFilesToUpload: number;
  totalBytesToUpload: number;
  hasStoredPassword: boolean;
}

export interface UploadProgressReport {
  phase: 'connecting' | 'scanning' | 'uploading' | 'done' | 'error';
  message: string;
  currentMapping?: string;
  currentFile?: string;
  uploadedFiles: number;
  skippedFiles: number;
  totalFiles: number;
  percent: number;
}
