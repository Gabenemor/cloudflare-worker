# KeyVid File Uploader - Cloudflare Worker

This Cloudflare Worker handles large video file uploads to Google Files API with real-time progress reporting back to Supabase.

## Features

- **Chunked Upload**: Uploads files in 8MB chunks as recommended by Google
- **Progress Reporting**: Real-time progress updates sent to Supabase
- **Retry Logic**: Automatic retries for failed chunks
- **CORS Support**: Proper CORS headers for web app integration
- **Error Handling**: Comprehensive error handling and logging

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure secrets:**
   ```bash
   # Add your Supabase anonymous key
   wrangler secret put SUPABASE_ANON_KEY

   # Add your Gemini API key  
   wrangler secret put GEMINI_API_KEY
   ```

3. **Create KV namespace:**
   ```bash
   # Create KV namespace for upload progress tracking
   wrangler kv:namespace create "UPLOAD_PROGRESS"
   wrangler kv:namespace create "UPLOAD_PROGRESS" --preview
   ```

4. **Update wrangler.toml:**
   - Replace `your_kv_namespace_id` with the actual KV namespace ID
   - Replace `your_preview_kv_namespace_id` with the preview namespace ID

5. **Deploy:**
   ```bash
   npm run deploy
   ```

## API Usage

### POST /

Upload a video file to Google Files API.

**Request Body:**
```json
{
  "fileUrl": "https://example.com/video.mp4",
  "mimeType": "video/mp4", 
  "displayName": "My Video",
  "geminiApiKey": "your-gemini-api-key",
  "videoId": "uuid-video-id",
  "supabaseAnonKey": "your-supabase-anon-key"
}
```

**Response:**
```json
{
  "success": true,
  "fileUri": "files/abc123", 
  "uploadId": "uuid-upload-id",
  "totalSize": 1048576,
  "message": "File uploaded successfully to Google Files API"
}
```

## Integration with Supabase

The worker sends progress updates to your Supabase Edge Function at:
`{SUPABASE_URL}/functions/v1/video-upload-progress`

Make sure you have this endpoint set up to receive progress updates.

## Development

```bash
# Start local development server
npm run dev

# Build (dry run)
npm run build

# Deploy to production
npm run deploy
```

## Environment Variables

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Supabase anonymous key (secret)
- `GEMINI_API_KEY`: Google Gemini API key (secret)

## KV Storage

The worker uses Cloudflare KV to store upload progress and session data for reliability and resumability.
