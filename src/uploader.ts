import { ProgressReporter } from './progress-reporter';
import { GoogleFilesUploadSession, ChunkUploadResult, FileUploadResult } from './types';

export class FileUploader {
  private static readonly CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks as recommended by Google
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY = 2000; // 2 seconds

  constructor(
    private geminiApiKey: string,
    private progressReporter: ProgressReporter,
    private kvStore: KVNamespace
  ) {}

  async uploadFile(
    fileUrl: string,
    mimeType: string,
    displayName: string
  ): Promise<FileUploadResult> {
    const uploadId = crypto.randomUUID();
    
    try {
      // Get file metadata using HEAD request (no download)
      const headResponse = await fetch(fileUrl, { method: 'HEAD' });
      if (!headResponse.ok) {
        throw new Error(`Failed to get file metadata: ${headResponse.statusText}`);
      }

      const totalSize = parseInt(headResponse.headers.get('content-length') || '0');
      if (totalSize === 0) {
        throw new Error('Unable to determine file size');
      }

      console.log(`📊 File size: ${Math.round(totalSize / 1024 / 1024)}MB - streaming in 8MB chunks`);

      // Report initial progress
      await this.progressReporter.reportProgress(uploadId, {
        bytesUploaded: 0,
        totalBytes: totalSize,
        percentage: 0,
        status: 'uploading',
        message: 'Starting streaming upload to Google Files API'
      });

      // Start resumable upload session
      const session = await this.startUploadSession(mimeType, displayName, totalSize);
      
      // Stream file directly from URL in chunks (no full download)
      const fileUri = await this.streamUploadInChunks(
        fileUrl,
        session,
        totalSize,
        uploadId,
        mimeType
      );

      // Poll for file active state with file size context
      const activeFileUri = await this.waitForFileActive(fileUri, totalSize);

      // Report completion
      await this.progressReporter.reportProgress(uploadId, {
        bytesUploaded: totalSize,
        totalBytes: totalSize,
        percentage: 100,
        status: 'completed',
        message: 'Streaming upload completed successfully'
      });

      return {
        fileUri: activeFileUri,
        uploadId,
        totalSize,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() // 48 hours
      };

    } catch (error) {
      await this.progressReporter.reportProgress(uploadId, {
        bytesUploaded: 0,
        totalBytes: 0,
        percentage: 0,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Streaming upload failed'
      });
      throw error;
    }
  }

  private async startUploadSession(
    mimeType: string,
    displayName: string,
    totalSize: number
  ): Promise<GoogleFilesUploadSession> {
    const uploadStartUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

    const response = await fetch(uploadStartUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.geminiApiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': totalSize.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: {
          display_name: displayName,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to start upload session: ${response.statusText} - ${errorText}`);
    }

    const uploadUrl = response.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) {
      throw new Error('Missing upload URL from Google Files API');
    }

    return { uploadUrl };
  }

  private async streamUploadInChunks(
    fileUrl: string,
    session: GoogleFilesUploadSession,
    totalSize: number,
    uploadId: string,
    mimeType: string
  ): Promise<string> {
    let bytesUploaded = 0;

    while (bytesUploaded < totalSize) {
      const remainingBytes = totalSize - bytesUploaded;
      const chunkSize = Math.min(FileUploader.CHUNK_SIZE, remainingBytes);
      const isLastChunk = bytesUploaded + chunkSize >= totalSize;
      
      // Fetch chunk using Range request (no full file download)
      const rangeEnd = bytesUploaded + chunkSize - 1;
      const chunkResponse = await fetch(fileUrl, {
        headers: {
          'Range': `bytes=${bytesUploaded}-${rangeEnd}`
        }
      });

      if (!chunkResponse.ok) {
        throw new Error(`Failed to fetch chunk at ${bytesUploaded}: ${chunkResponse.statusText}`);
      }

      const chunkBuffer = await chunkResponse.arrayBuffer();
      const chunk = new Uint8Array(chunkBuffer);
      
      const result = await this.uploadChunk(
        session.uploadUrl,
        chunk,
        bytesUploaded,
        totalSize,
        mimeType,
        isLastChunk
      );

      if (!result.success) {
        throw new Error(`Chunk upload failed: ${result.error}`);
      }

      bytesUploaded += result.bytesUploaded;
      
      // Report progress
      await this.progressReporter.reportProgress(uploadId, {
        bytesUploaded,
        totalBytes: totalSize,
        percentage: Math.round((bytesUploaded / totalSize) * 100),
        status: isLastChunk ? 'finalizing' : 'uploading',
        message: isLastChunk ? 'Finalizing streaming upload' : `Streamed ${Math.round(bytesUploaded / 1024 / 1024)}MB`
      });

      // If this was the last chunk, get the file URI from the response
      if (isLastChunk && result.fileUri) {
        return result.fileUri;
      }
    }

    throw new Error('Streaming upload completed but no file URI received');
  }

  private async uploadChunk(
    uploadUrl: string,
    chunk: Uint8Array,
    offset: number,
    totalSize: number,
    mimeType: string,
    isLastChunk: boolean
  ): Promise<ChunkUploadResult & { fileUri?: string }> {
    for (let attempt = 0; attempt < FileUploader.MAX_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Length': chunk.length.toString(),
          'X-Goog-Upload-Offset': offset.toString(),
          'Content-Type': mimeType,
        };

        if (isLastChunk) {
          headers['X-Goog-Upload-Command'] = 'upload, finalize';
        } else {
          headers['X-Goog-Upload-Command'] = 'upload';
        }

        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers,
          body: chunk,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result: ChunkUploadResult & { fileUri?: string } = {
          success: true,
          bytesUploaded: chunk.length,
        };

        // If this was the last chunk, parse the response for file URI
        if (isLastChunk) {
          try {
            const responseData = await response.json();
            if (responseData.file && responseData.file.uri) {
              result.fileUri = responseData.file.uri;
            }
          } catch (e) {
            console.warn('Failed to parse final upload response:', e);
          }
        }

        return result;

      } catch (error) {
        console.warn(`Chunk upload attempt ${attempt + 1} failed:`, error);
        
        if (attempt === FileUploader.MAX_RETRIES - 1) {
          return {
            success: false,
            bytesUploaded: 0,
            error: error instanceof Error ? error.message : 'Chunk upload failed',
          };
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, FileUploader.RETRY_DELAY));
      }
    }

    return {
      success: false,
      bytesUploaded: 0,
      error: 'Max retries exceeded',
    };
  }

  private async waitForFileActive(fileUri: string, fileSizeBytes: number = 0): Promise<string> {
    const fileId = fileUri.split('/').pop();
    
    // Dynamic timeout based on file size
    const fileSizeMB = fileSizeBytes / (1024 * 1024);
    const baseTimeoutSeconds = 60; // Base timeout for small files
    const additionalTimePerMB = 0.5; // 0.5 seconds per MB
    const maxTimeoutSeconds = 300; // 5 minutes maximum
    
    const timeoutSeconds = Math.min(
      baseTimeoutSeconds + (fileSizeMB * additionalTimePerMB),
      maxTimeoutSeconds
    );
    
    console.log(`📊 File activation timeout: ${Math.round(timeoutSeconds)}s for ${Math.round(fileSizeMB)}MB file`);
    
    // Exponential backoff polling strategy
    let attempt = 0;
    const startTime = Date.now();
    const maxAttempts = Math.ceil(timeoutSeconds / 2); // Ensure we have enough attempts
    
    while (Date.now() - startTime < timeoutSeconds * 1000) {
      attempt++;
      
      try {
        const statusUrl = `https://generativelanguage.googleapis.com/v1beta/files/${fileId}`;
        const response = await fetch(statusUrl, {
          headers: {
            'x-goog-api-key': this.geminiApiKey,
          },
        });

        if (!response.ok) {
          console.warn(`File status check failed: ${response.statusText}`);
        } else {
          const statusData = await response.json();
          console.log(`📋 File status check ${attempt}: ${statusData.state} (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
          
          if (statusData.state === 'ACTIVE') {
            console.log(`✅ File is now ACTIVE after ${Math.round((Date.now() - startTime) / 1000)}s`);
            return fileUri;
          }
          
          if (statusData.state === 'FAILED') {
            throw new Error(`File processing failed in Google Files API: ${statusData.error || 'Unknown error'}`);
          }
        }
        
      } catch (error) {
        console.warn(`Status check attempt ${attempt} failed:`, error);
      }
      
      // Exponential backoff with jitter: start at 1s, increase gradually, max 5s
      const baseDelay = Math.min(1000 * Math.pow(1.5, attempt - 1), 5000);
      const jitter = Math.random() * 1000; // Add up to 1s random jitter
      const delay = baseDelay + jitter;
      
      console.log(`⏱️ Waiting ${Math.round(delay / 1000)}s before next check...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Provide detailed timeout error with context
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    const errorMessage = `File did not become ACTIVE within ${Math.round(timeoutSeconds)}s timeout (${elapsedSeconds}s elapsed, ${attempt} attempts). Large files (${Math.round(fileSizeMB)}MB) may need more processing time.`;
    
    console.error(`❌ ${errorMessage}`);
    throw new Error(errorMessage);
  }
}
