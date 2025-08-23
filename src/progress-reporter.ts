import { UploadProgress } from './types';

export class ProgressReporter {
  constructor(
    private supabaseUrl: string,
    private supabaseAnonKey: string,
    private videoId: string
  ) {}

  async reportProgress(
    uploadId: string,
    progress: Omit<UploadProgress, 'uploadId' | 'videoId' | 'timestamp'>
  ): Promise<void> {
    try {
      const fullProgress: UploadProgress = {
        ...progress,
        uploadId,
        videoId: this.videoId,
        timestamp: new Date().toISOString(),
      };

      console.log(`📊 Reporting progress - ${progress.status}: ${progress.percentage}% (${progress.bytesUploaded}/${progress.totalBytes})`);
      if (progress.message) {
        console.log(`📝 Message: ${progress.message}`);
      }

      // Send progress update to Supabase Edge Function
      const progressUrl = `${this.supabaseUrl}/functions/v1/cloudflare-worker-manager?action=progress`;
      
      const response = await fetch(progressUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.supabaseAnonKey}`,
        },
        body: JSON.stringify(fullProgress),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(`❌ Failed to report progress: ${response.status} ${response.statusText} - ${errorText}`);
        
        // For failed status, this is critical - try to log the error
        if (progress.status === 'failed') {
          console.error(`🚨 CRITICAL: Failed to report upload failure to Supabase for video ${this.videoId}`);
        }
      } else {
        console.log(`✅ Progress reported successfully to Supabase`);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Progress reporting failed for video ${this.videoId}:`, errorMessage);
      
      // For failed status, this is critical
      if (progress.status === 'failed') {
        console.error(`🚨 CRITICAL: Could not notify Supabase of upload failure - video may be stuck in processing state`);
      }
    }
  }
}
