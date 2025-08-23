import { FileUploader } from './uploader';
import { ProgressReporter } from './progress-reporter';
import { validateRequest, corsHeaders, handleCors } from './utils';
import { UploadRequest, UploadResponse } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // Validate request
      const validation = await validateRequest(request);
      if (!validation.isValid) {
        return new Response(
          JSON.stringify({ error: validation.error }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      }

      const uploadRequest: UploadRequest = validation.data!;
      
      // Initialize progress reporter
      const progressReporter = new ProgressReporter(
        env.SUPABASE_URL,
        env.SUPABASE_ANON_KEY,
        uploadRequest.videoId
      );

      // Initialize file uploader
      const uploader = new FileUploader(
        uploadRequest.geminiApiKey,
        progressReporter,
        env.KV
      );

      // Start upload process
      const result = await uploader.uploadFile(
        uploadRequest.fileUrl,
        uploadRequest.mimeType,
        uploadRequest.displayName
      );

      const response: UploadResponse = {
        success: true,
        fileUri: result.fileUri,
        uploadId: result.uploadId,
        totalSize: result.totalSize,
        expiresAt: result.expiresAt,
        message: 'File uploaded successfully to Google Files API'
      };

      return new Response(
        JSON.stringify(response),
        { 
          status: 200, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );

    } catch (error) {
      console.error('Upload failed:', error);
      
      const errorResponse: UploadResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Upload failed'
      };

      return new Response(
        JSON.stringify(errorResponse),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }
  }
};

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  GEMINI_API_KEY: string;
  KV: KVNamespace;
}
