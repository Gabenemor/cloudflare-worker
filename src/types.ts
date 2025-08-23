export interface UploadRequest {
  fileUrl: string;
  mimeType: string;
  displayName: string;
  geminiApiKey: string;
  videoId: string;
  supabaseAnonKey: string;
}

export interface UploadResponse {
  success: boolean;
  fileUri?: string;
  uploadId?: string;
  totalSize?: number;
  expiresAt?: string;
  error?: string;
  message?: string;
}

export interface UploadProgress {
  uploadId: string;
  videoId: string;
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  status: 'uploading' | 'finalizing' | 'completed' | 'failed';
  message?: string;
  timestamp: string;
}

export interface GoogleFilesUploadSession {
  uploadUrl: string;
  fileUri?: string;
}

export interface ChunkUploadResult {
  success: boolean;
  bytesUploaded: number;
  error?: string;
}

export interface FileUploadResult {
  fileUri: string;
  uploadId: string;
  totalSize: number;
  expiresAt: string;
}
