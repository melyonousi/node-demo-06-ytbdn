# Deployment

## Target

- Host the container on Hetzner through Coolify.
- Publish it behind Cloudflare on a dedicated API hostname such as `api.example.com`.

## Coolify

- Build pack: `Dockerfile`
- Port: `3000`
- Health check path: `/health`
- Persistent storage: not required

## Required environment

Copy from `.env.example` and set real values.

- `FRONT_URL`: public frontend URL
- `CORS_ALLOWED_ORIGINS`: comma-separated frontend origins allowed to call the API directly
- `TRUST_PROXY=true`: keeps protocol and client IP correct behind Coolify and Cloudflare

## Notes

- `ffmpeg` and `yt-dlp` are installed in the image, so audio extraction and merged video downloads work in production.
- If the Angular SSR app proxies `/api` to this service, browser CORS is no longer needed. In that setup you can still keep `CORS_ALLOWED_ORIGINS` set as a fallback.
