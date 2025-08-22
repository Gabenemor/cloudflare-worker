import { UploadRequest } from './types';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400', // 24 hours
};

export function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function validateRequest(request: Request): Promise<{
  isValid: boolean;
  error?: string;
  data?: UploadRequest;
}> {
  if (request.method !== 'POST') {
    return {
      isValid: false,
      error: 'Method not allowed. Use POST.',
    };
  }

  const contentType = request.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    return {
      isValid: false,
      error: 'Content-Type must be application/json',
    };
  }

  try {
    const data = await request.json() as UploadRequest;
    
    // Validate required fields
    const requiredFields = [
      'fileUrl',
      'mimeType', 
      'displayName',
      'geminiApiKey',
      'videoId',
      'supabaseAnonKey'
    ];

    for (const field of requiredFields) {
      if (!data[field as keyof UploadRequest]) {
        return {
          isValid: false,
          error: `Missing required field: ${field}`,
        };
      }
    }

    // Validate URL format
    try {
      new URL(data.fileUrl);
    } catch {
      return {
        isValid: false,
        error: 'Invalid fileUrl format',
      };
    }

    // Validate MIME type is video
    if (!data.mimeType.startsWith('video/')) {
      return {
        isValid: false,
        error: 'Invalid mimeType. Must be a video format.',
      };
    }

    return {
      isValid: true,
      data,
    };

  } catch (error) {
    return {
      isValid: false,
      error: 'Invalid JSON body',
    };
  }
}

export function generateUploadId(): string {
  return crypto.randomUUID();
}

export function formatBytes(bytes: number): string {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

export function calculateProgress(uploaded: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((uploaded / total) * 100);
}
