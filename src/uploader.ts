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
      // Fetch the file to get total size
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      const totalSize = parseInt(response.headers.get('content-length') || '0');
      if (totalSize === 0) {
        throw new Error('Unable to determine file size');
      }

      // Report initial progress
      await this.progressReporter.reportProgress(uploadId, {
        bytesUploaded: 0,
        totalBytes: totalSize,
        percentage: 0,
        status: 'uploading',
        message: 'Starting upload to Google Files API'
      });

      // Start resumable upload session
      const session = await this.startUploadSession(mimeType, displayName, totalSize);
      
      // Stream and upload file in chunks
      const fileUri = await this.uploadInChunks(
        response.body!,
        session,
        totalSize,
        uploadId,
        mimeType
      );

      // Poll for file active state
      const activeFileUri = await this.waitForFileActive(fileUri);

      // Report completion
      await this.progressReporter.reportProgress(uploadId, {
        bytesUploaded: totalSize,
        totalBytes: totalSize,
        percentage: 100,
        status: 'completed',
        message: 'Upload completed successfully'
      });

      return {
        fileUri: activeFileUri,
        uploadId,
        totalSize
      };

    } catch (error) {
      await this.progressReporter.reportProgress(uploadId, {
        bytesUploaded: 0,
        totalBytes: 0,
        percentage: 0,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Upload failed'
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

  private async uploadInChunks(
    stream: ReadableStream<Uint8Array>,
    session: GoogleFilesUploadSession,
    totalSize: number,
    uploadId: string,
    mimeType: string
  ): Promise<string> {
    const reader = stream.getReader();
    let bytesUploaded = 0;
    let buffer = new Uint8Array(0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (value) {
          // Append new data to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;
        }

        // Upload chunks when buffer is large enough or stream is done
        while (buffer.length >= FileUploader.CHUNK_SIZE || (done && buffer.length > 0)) {
          const chunkSize = Math.min(FileUploader.CHUNK_SIZE, buffer.length);
          const chunk = buffer.slice(0, chunkSize);
          buffer = buffer.slice(chunkSize);

          const isLastChunk = done && buffer.length === 0;
          
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
            message: isLastChunk ? 'Finalizing upload' : `Uploaded ${Math.round(bytesUploaded / 1024 / 1024)}MB`
          });

          // If this was the last chunk, get the file URI from the response
          if (isLastChunk && result.fileUri) {
            return result.fileUri;
          }
        }

        if (done) break;
      }

      throw new Error('Upload completed but no file URI received');
      
    } finally {
      reader.releaseLock();
    }
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

  private async waitForFileActive(fileUri: string): Promise<string> {
    const fileId = fileUri.split('/').pop();
    const maxAttempts = 10;
    const pollInterval = 2000; // 2 seconds

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const statusUrl = `https://generativelanguage.googleapis.com/v1beta/files/${fileId}`;
        const response = await fetch(statusUrl, {
          headers: {
            'x-goog-api-key': this.geminiApiKey,
          },
        });

        if (!response.ok) {
          console.warn(`File status check failed: ${response.statusText}`);
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

        const statusData = await response.json();
        if (statusData.state === 'ACTIVE') {
          console.log('File is now ACTIVE in Google Files API');
          return fileUri;
        }

        console.log(`File status: ${statusData.state}, waiting...`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
      } catch (error) {
        console.warn(`Status check attempt ${i + 1} failed:`, error);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(`File did not become ACTIVE within ${maxAttempts * pollInterval / 1000} seconds`);
  }
}
