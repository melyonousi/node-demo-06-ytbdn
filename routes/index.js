const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const YTDlpWrap = require('yt-dlp-wrap').default;
const { spawn, spawnSync } = require('child_process');
let ffmpegBinary = null;

try {
    ffmpegBinary = require('ffmpeg-static');
} catch (_) {
    ffmpegBinary = null;
}

const localYtDlpBinary = path.join(
    __dirname,
    '..',
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

const tempDownloadDir = path.join(__dirname, '..', 'tmp-downloads');

const downloadJobs = new Map();
const READY_JOB_TTL_MS = 20 * 60 * 1000;
const ERROR_JOB_TTL_MS = 10 * 60 * 1000;
const DOWNLOADING_JOB_TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

let resolvedYtDlpCommand = null;
let ensureYtDlpPromise = null;

function isCommandAvailable(command, baseArgs = []) {
    const result = spawnSync(command, [...baseArgs, '--version'], {
        stdio: 'ignore',
        windowsHide: true
    });

    return !result.error && result.status === 0;
}

function resolveYtDlpCommand() {
    if (resolvedYtDlpCommand) {
        return resolvedYtDlpCommand;
    }

    const candidates = [];

    if (process.env.YT_DLP_PATH) {
        candidates.push({ command: process.env.YT_DLP_PATH, baseArgs: [] });
    }

    if (fs.existsSync(localYtDlpBinary)) {
        candidates.push({ command: localYtDlpBinary, baseArgs: [] });
    }

    if (process.platform === 'win32') {
        candidates.push({ command: 'yt-dlp.exe', baseArgs: [] });
    }

    candidates.push({ command: 'yt-dlp', baseArgs: [] });

    for (const candidate of candidates) {
        if (isCommandAvailable(candidate.command, candidate.baseArgs)) {
            resolvedYtDlpCommand = candidate;
            return candidate;
        }
    }

    return null;
}

async function ensureYtDlpBinary() {
    const existing = resolveYtDlpCommand();
    if (existing) {
        return existing;
    }

    if (!ensureYtDlpPromise) {
        ensureYtDlpPromise = (async () => {
            fs.mkdirSync(path.dirname(localYtDlpBinary), { recursive: true });
            await YTDlpWrap.downloadFromGithub(localYtDlpBinary);

            if (process.platform !== 'win32') {
                fs.chmodSync(localYtDlpBinary, 0o755);
            }

            process.env.YT_DLP_PATH = localYtDlpBinary;
        })().finally(() => {
            ensureYtDlpPromise = null;
        });
    }

    await ensureYtDlpPromise;

    const downloaded = resolveYtDlpCommand();
    if (downloaded) {
        return downloaded;
    }

    throw new Error('yt-dlp not found. Install it manually or set YT_DLP_PATH.');
}

function spawnYtDlp(args, options = {}) {
    if (!resolvedYtDlpCommand) {
        throw new Error('yt-dlp is not initialized');
    }

    return spawn(
        resolvedYtDlpCommand.command,
        [...resolvedYtDlpCommand.baseArgs, ...args],
        { windowsHide: true, ...options }
    );
}

function sanitizeFileName(value, fallback = 'media') {
    const normalized = String(value || fallback)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) {
        return fallback;
    }

    return normalized.slice(0, 180);
}

function buildContentDisposition(fileName) {
    const safeAscii = fileName
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/"/g, '');

    return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function createTempFilePath(extension) {
    fs.mkdirSync(tempDownloadDir, { recursive: true });
    const safeExtension = String(extension || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
    return path.join(tempDownloadDir, `${Date.now()}-${crypto.randomUUID()}.${safeExtension}`);
}

function createTempOutputBasePath() {
    fs.mkdirSync(tempDownloadDir, { recursive: true });
    return path.join(tempDownloadDir, `${Date.now()}-${crypto.randomUUID()}`);
}

async function resolveGeneratedOutputPath(basePath) {
    try {
        const stat = await fsp.stat(basePath);
        if (stat.isFile()) {
            return basePath;
        }
    } catch (_) {
        // ignore
    }

    const directory = path.dirname(basePath);
    const baseName = path.basename(basePath);
    const prefix = `${baseName}.`;
    const entries = await fsp.readdir(directory);
    const matchedFiles = [];

    for (const entry of entries) {
        if (!entry.startsWith(prefix)) {
            continue;
        }

        const fullPath = path.join(directory, entry);
        try {
            const stat = await fsp.stat(fullPath);
            if (stat.isFile()) {
                matchedFiles.push({
                    fullPath,
                    mtimeMs: stat.mtimeMs
                });
            }
        } catch (_) {
            // ignore
        }
    }

    if (matchedFiles.length === 0) {
        throw new Error('Downloaded file was not generated');
    }

    matchedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matchedFiles[0].fullPath;
}

async function removeFileQuietly(filePath) {
    try {
        await fsp.unlink(filePath);
    } catch (_) {
        // ignore
    }
}

function isManifestProtocol(protocol) {
    const normalized = String(protocol || '').toLowerCase();
    return normalized.includes('m3u8') || normalized.includes('dash') || normalized.includes('ism');
}

function getContentTypeByExtension(ext, fallback = 'application/octet-stream') {
    const extension = String(ext || '').toLowerCase();
    const map = {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        webm: 'video/webm',
        mp4: 'video/mp4'
    };

    return map[extension] || fallback;
}

function getMp3QualityValue(audioQuality) {
    const normalized = String(audioQuality || '').toUpperCase();

    if (normalized.includes('LOW')) {
        return '7';
    }

    if (normalized.includes('MEDIUM')) {
        return '5';
    }

    return '0';
}

const hasNodeJsRuntime = isCommandAvailable('node');
const configuredExtractorArgs = String(process.env.YT_DLP_EXTRACTOR_ARGS || '').trim();
const forceIpv4 = process.env.YT_DLP_FORCE_IPV4 !== '0';
const defaultRetryExtractorArgs = Object.freeze([
    'youtube:player_client=web',
    'youtube:player_client=web_safari',
    'youtube:player_client=tv,web'
]);
const configuredCookiesPath = String(
    process.env.YT_DLP_COOKIES_PATH
    || process.env.YT_DLP_COOKIE_FILE
    || ''
).trim();
const configuredCookiesInline = String(process.env.YT_DLP_COOKIES || '').trim();
const configuredCookiesBase64 = String(process.env.YT_DLP_COOKIES_BASE64 || '').trim();
const cookiesRuntimeDir = String(process.env.YT_DLP_COOKIE_RUNTIME_DIR || '').trim() || os.tmpdir();

let resolvedCookiesFilePath = null;
let cookiesSourceHash = null;
let cookieWarningLogged = false;

function getYtDlpSharedArgs(options = {}) {
    const { includeFfmpeg = false } = options;
    const sharedArgs = [];

    if (hasNodeJsRuntime) {
        sharedArgs.push('--js-runtimes', 'node');
    }

    if (forceIpv4) {
        sharedArgs.push('--force-ipv4');
    }

    if (configuredExtractorArgs) {
        sharedArgs.push('--extractor-args', configuredExtractorArgs);
    }

    const cookiesPath = getYtDlpCookiesFilePath();
    if (cookiesPath) {
        sharedArgs.push('--cookies', cookiesPath);
    }

    if (includeFfmpeg && ffmpegBinary) {
        sharedArgs.push('--ffmpeg-location', ffmpegBinary);
    }

    return sharedArgs;
}

function resolveCookiesRawContent() {
    if (configuredCookiesInline) {
        return configuredCookiesInline;
    }

    if (configuredCookiesBase64) {
        return Buffer.from(configuredCookiesBase64, 'base64').toString('utf8');
    }

    return '';
}

function getYtDlpCookiesFilePath() {
    if (configuredCookiesPath) {
        return configuredCookiesPath;
    }

    if (!configuredCookiesInline && !configuredCookiesBase64) {
        return null;
    }

    try {
        const rawContent = resolveCookiesRawContent();
        if (!rawContent) {
            return null;
        }

        const nextHash = crypto.createHash('sha256').update(rawContent).digest('hex');
        if (
            resolvedCookiesFilePath
            && cookiesSourceHash === nextHash
            && fs.existsSync(resolvedCookiesFilePath)
        ) {
            return resolvedCookiesFilePath;
        }

        fs.mkdirSync(cookiesRuntimeDir, { recursive: true });
        const filePath = path.join(cookiesRuntimeDir, 'yt-dlp-cookies.txt');
        fs.writeFileSync(filePath, rawContent, { encoding: 'utf8', mode: 0o600 });

        resolvedCookiesFilePath = filePath;
        cookiesSourceHash = nextHash;
        return filePath;
    } catch (error) {
        if (!cookieWarningLogged) {
            cookieWarningLogged = true;
            console.error('Failed to prepare yt-dlp cookies:', error.message);
        }

        return null;
    }
}

function parseRetryExtractorArgsFromEnv() {
    const rawValue = String(process.env.YT_DLP_RETRY_EXTRACTOR_ARGS || '').trim();
    if (!rawValue) {
        return defaultRetryExtractorArgs;
    }

    const parsed = rawValue
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean);

    return parsed.length > 0 ? parsed : defaultRetryExtractorArgs;
}

function shouldRetryYtDlpWithAlternateProfile(errorMessage) {
    const text = String(errorMessage || '').toLowerCase();
    return text.includes('http error 403') || text.includes('unable to download video data');
}

function getPublicYtDlpErrorMessage(rawMessage) {
    const text = String(rawMessage || '').toLowerCase();

    if (text.includes('sign in to confirm you\'re not a bot')) {
        return 'YouTube requires authentication for this request. Configure YT_DLP_COOKIES_BASE64 or YT_DLP_COOKIES_PATH on the server and try again.';
    }

    if (text.includes('http error 403')) {
        return 'YouTube blocked this download request (HTTP 403). Try again later or configure authenticated cookies.';
    }

    return normalizeYtDlpErrorMessage(rawMessage);
}

function buildYtDlpSharedArgProfiles(options = {}) {
    const baseArgs = getYtDlpSharedArgs(options);
    const profiles = [baseArgs];

    if (configuredExtractorArgs) {
        return profiles;
    }

    for (const extractorArgs of parseRetryExtractorArgsFromEnv()) {
        profiles.push([...baseArgs, '--extractor-args', extractorArgs]);
    }

    return profiles;
}

function executeYtDlpProcess(args, options = {}) {
    const { onProgress } = options;

    return new Promise((resolve, reject) => {
        const ytDlpProcess = spawnYtDlp(args);
        let processOutput = '';
        let stderrBuffer = '';
        let stdoutBuffer = '';

        const handleLine = (line, source) => {
            if (!line) {
                return;
            }

            processOutput += `${line}\n`;

            if (source === 'stderr') {
                console.error(`yt-dlp stderr: ${line}`);
            }

            const progress = extractProgressPercent(line);
            if (progress !== null && typeof onProgress === 'function') {
                onProgress(progress, line);
            }
        };

        const consumeBuffer = (chunk, source) => {
            if (source === 'stderr') {
                stderrBuffer += chunk.toString();
                const lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop() || '';

                for (const line of lines) {
                    handleLine(line.trim(), source);
                }

                return;
            }

            stdoutBuffer += chunk.toString();
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';

            for (const line of lines) {
                handleLine(line.trim(), source);
            }
        };

        ytDlpProcess.stderr.on('data', (chunk) => consumeBuffer(chunk, 'stderr'));
        ytDlpProcess.stdout.on('data', (chunk) => consumeBuffer(chunk, 'stdout'));

        ytDlpProcess.on('error', (error) => {
            reject(new Error(processOutput || error.message));
        });

        ytDlpProcess.on('close', (code) => {
            if (stderrBuffer.trim()) {
                handleLine(stderrBuffer.trim(), 'stderr');
                stderrBuffer = '';
            }

            if (stdoutBuffer.trim()) {
                handleLine(stdoutBuffer.trim(), 'stdout');
                stdoutBuffer = '';
            }

            if (code !== 0) {
                return reject(new Error(processOutput || `yt-dlp exited with code ${code}`));
            }

            resolve();
        });
    });
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function extractProgressPercent(line) {
    const match = line.match(/(\d{1,3}(?:\.\d+)?)%/);

    if (!match) {
        return null;
    }

    const parsed = Number(match[1]);
    if (Number.isNaN(parsed)) {
        return null;
    }

    return clampNumber(parsed, 0, 100);
}

function createDownloadJob(type) {
    const now = Date.now();
    const job = {
        id: crypto.randomUUID(),
        type,
        status: 'preparing',
        progress: 0,
        message: 'Preparing file on server...',
        error: null,
        filePath: null,
        fileName: null,
        contentType: null,
        fileSize: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + READY_JOB_TTL_MS
    };

    downloadJobs.set(job.id, job);
    return job;
}

function updateDownloadJob(jobId, updates) {
    const job = downloadJobs.get(jobId);
    if (!job) {
        return null;
    }

    const nextJob = {
        ...job,
        ...updates,
        updatedAt: Date.now()
    };

    downloadJobs.set(jobId, nextJob);
    return nextJob;
}

function getPublicDownloadJob(job) {
    return {
        jobId: job.id,
        status: job.status,
        type: job.type,
        progress: job.progress,
        message: job.message,
        error: job.error,
        fileName: job.fileName,
        fileSize: job.fileSize
    };
}

async function cleanupExpiredJobs() {
    const now = Date.now();

    for (const [jobId, job] of downloadJobs.entries()) {
        if (job.expiresAt > now) {
            continue;
        }

        if (job.filePath) {
            await removeFileQuietly(job.filePath);
        }

        downloadJobs.delete(jobId);
    }
}

setInterval(() => {
    cleanupExpiredJobs().catch((error) => {
        console.error('Failed to cleanup expired download jobs:', error.message);
    });
}, CLEANUP_INTERVAL_MS).unref();

async function runYtDlpCommand(args, options = {}) {
    await ensureYtDlpBinary();
    const sharedArgProfiles = buildYtDlpSharedArgProfiles({ includeFfmpeg: true });
    let latestError = null;

    for (let index = 0; index < sharedArgProfiles.length; index += 1) {
        const sharedArgs = sharedArgProfiles[index];
        const hasMoreProfiles = index < sharedArgProfiles.length - 1;

        try {
            await executeYtDlpProcess([...sharedArgs, ...args], options);
            return;
        } catch (error) {
            latestError = error;

            const shouldRetry = hasMoreProfiles
                && shouldRetryYtDlpWithAlternateProfile(error?.message);

            if (!shouldRetry) {
                throw error;
            }

            console.warn('yt-dlp returned HTTP 403; retrying with an alternate extractor profile');
        }
    }

    throw latestError || new Error('yt-dlp command failed');
}

async function sendTempFile(res, filePath, fileName, contentType) {
    const stat = await fsp.stat(filePath);

    res.setHeader('Content-Disposition', buildContentDisposition(fileName));
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(stat.size));

    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        removeFileQuietly(filePath);
    };

    res.once('finish', cleanup);
    res.once('close', cleanup);

    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
        console.error('File stream error:', error.message);
        cleanup();
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to send downloaded file' });
        } else {
            res.destroy(error);
        }
    });

    stream.pipe(res);
}

async function getYtDlpInfo(url, extraOptions = []) {
    await ensureYtDlpBinary();

    return new Promise((resolve, reject) => {
        const args = [...getYtDlpSharedArgs(), '--dump-json', ...extraOptions, url];
        const ytDlpProcess = spawnYtDlp(args);
        let stdout = '';
        let stderr = '';

        ytDlpProcess.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        ytDlpProcess.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        ytDlpProcess.on('error', (error) => {
            const message = stderr || error.message;
            console.error(`yt-dlp error: ${message}`);
            reject(new Error(message));
        });

        ytDlpProcess.on('close', (code) => {
            if (code !== 0) {
                const message = stderr || `yt-dlp exited with code ${code}`;
                console.error(`yt-dlp error: ${message}`);
                return reject(new Error(message));
            }

            try {
                const lines = stdout
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean);
                const parsed = JSON.parse(lines[0] || '{}');
                resolve(parsed);
            } catch (_) {
                console.error(`Failed to parse yt-dlp output: ${stdout}`);
                reject(new Error('Failed to parse yt-dlp output'));
            }
        });
    });
}

async function getYtDlpSingleJson(url, extraOptions = []) {
    await ensureYtDlpBinary();

    return new Promise((resolve, reject) => {
        const args = [...getYtDlpSharedArgs(), '--dump-single-json', ...extraOptions, url];
        const ytDlpProcess = spawnYtDlp(args);
        let stdout = '';
        let stderr = '';

        ytDlpProcess.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        ytDlpProcess.stderr.on('data', (chunk) => {
            const message = chunk.toString();
            stderr += message;
            console.error(`yt-dlp stderr: ${message.trim()}`);
        });

        ytDlpProcess.on('error', (error) => {
            reject(new Error(stderr || error.message));
        });

        ytDlpProcess.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
            }

            try {
                const lines = stdout
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean);
                const jsonLine = lines.find((line) => line.startsWith('{')) || '{}';
                const parsed = JSON.parse(jsonLine);
                resolve(parsed);
            } catch (_) {
                reject(new Error('Failed to parse yt-dlp playlist output'));
            }
        });
    });
}

function formatPlaylistDuration(durationSeconds) {
    const duration = Number(durationSeconds);
    if (!duration || Number.isNaN(duration)) {
        return 'Unknown';
    }

    const totalSeconds = Math.floor(duration);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function buildPlaylistEntryUrl(entry) {
    if (entry?.url && String(entry.url).startsWith('http')) {
        return entry.url;
    }

    if (entry?.id) {
        return `https://www.youtube.com/watch?v=${entry.id}`;
    }

    return null;
}

const PLAYLIST_DEFAULT_QUALITY_LABELS = Object.freeze([
    { qualityLabel: '1080p' },
    { qualityLabel: '720p' },
    { qualityLabel: '480p' },
    { qualityLabel: '360p' }
]);

function isPlaylistEntryUnavailable(entry) {
    const title = String(entry?.title || '').toLowerCase();
    const availability = String(entry?.availability || '').toLowerCase();

    if (title.includes('[private video]') || title.includes('[deleted video]')) {
        return true;
    }

    return availability === 'private'
        || availability === 'needs_auth'
        || availability === 'subscriber_only'
        || availability === 'premium_only'
        || availability === 'unavailable';
}

function getPlaylistEntryUnavailableReason(entry) {
    const title = String(entry?.title || '').toLowerCase();
    const availability = String(entry?.availability || '').toLowerCase();

    if (title.includes('[private video]') || availability === 'private') {
        return 'This video is private';
    }

    if (title.includes('[deleted video]')) {
        return 'This video was deleted';
    }

    if (availability === 'needs_auth') {
        return 'Sign-in is required to access this video';
    }

    if (availability === 'subscriber_only' || availability === 'premium_only') {
        return 'This video requires membership access';
    }

    return 'This video is unavailable or private';
}

function parseQualityHeight(qualityLabel) {
    const match = String(qualityLabel || '').match(/(\d{3,4})p/i);
    if (!match) {
        return null;
    }

    const parsed = Number(match[1]);
    return Number.isNaN(parsed) ? null : parsed;
}

function compareFormatsByQuality(a, b) {
    const heightA = a?.height || 0;
    const heightB = b?.height || 0;
    if (heightB !== heightA) {
        return heightB - heightA;
    }

    return (b?.tbr || 0) - (a?.tbr || 0);
}

function buildVideoQualityOptions(formats = []) {
    const labelMap = new Map();

    for (const format of formats) {
        if (!format?.format_id) {
            continue;
        }

        if (format.vcodec === 'none') {
            continue;
        }

        if (isManifestProtocol(format.protocol)) {
            continue;
        }

        const note = String(format.format_note || '').toLowerCase();
        if (note.includes('storyboard')) {
            continue;
        }

        const height = format.height || parseQualityHeight(format.quality_label || format.format_note);
        if (!height) {
            continue;
        }

        const qualityLabel = `${height}p`;
        const candidate = {
            qualityLabel,
            height,
            tbr: format.tbr || 0,
            hasAudio: format.acodec && format.acodec !== 'none',
            ext: format.ext || null
        };

        const existing = labelMap.get(qualityLabel);
        if (!existing) {
            labelMap.set(qualityLabel, candidate);
            continue;
        }

        if ((candidate.hasAudio ? 1 : 0) > (existing.hasAudio ? 1 : 0)) {
            labelMap.set(qualityLabel, candidate);
            continue;
        }

        if ((candidate.hasAudio ? 1 : 0) === (existing.hasAudio ? 1 : 0) && candidate.tbr > existing.tbr) {
            labelMap.set(qualityLabel, candidate);
        }
    }

    return Array.from(labelMap.values())
        .sort(compareFormatsByQuality)
        .map((item) => ({
            qualityLabel: item.qualityLabel,
            height: item.height
        }));
}

function buildVideoFormatSelector(qualityLabel) {
    const requestedHeight = parseQualityHeight(qualityLabel);
    const heightFilter = requestedHeight ? `[height<=${requestedHeight}]` : '';

    return [
        `bestvideo[ext=mp4]${heightFilter}+bestaudio[ext=m4a]`,
        `bestvideo${heightFilter}+bestaudio`,
        `best[ext=mp4]${heightFilter}`,
        `best${heightFilter}`
    ].join('/');
}

function pickVideoFormat(info, qualityLabel) {
    const progressiveFormats = (info.formats || []).filter(
        (format) =>
            format?.format_id
            && format.vcodec !== 'none'
            && format.acodec !== 'none'
            && !isManifestProtocol(format.protocol)
    );

    if (progressiveFormats.length === 0) {
        return null;
    }

    const exactMatch = progressiveFormats.find(
        (format) =>
            format.format_note === qualityLabel
            || format.quality_label === qualityLabel
            || (format.height && `${format.height}p` === qualityLabel)
    );

    if (exactMatch) {
        return exactMatch;
    }

    const requestedHeight = parseQualityHeight(qualityLabel);
    const sortedFormats = [...progressiveFormats].sort(compareFormatsByQuality);

    if (requestedHeight) {
        const closestLowerOrEqual = sortedFormats.find((format) => (format.height || 0) <= requestedHeight);
        if (closestLowerOrEqual) {
            return closestLowerOrEqual;
        }
    }

    return sortedFormats[0];
}

function normalizeYtDlpErrorMessage(rawMessage) {
    const lines = String(rawMessage || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return 'Internal Server Error';
    }

    const errorLine = [...lines].reverse().find((line) => line.toLowerCase().startsWith('error:'));
    if (errorLine) {
        return errorLine.replace(/^error:\s*/i, '').trim();
    }

    return lines[lines.length - 1];
}

function getYtDlpErrorStatus(message) {
    const text = String(message || '').toLowerCase();

    if (text.includes('http error 404') || text.includes('not found') || text.includes('does not exist')) {
        return 404;
    }

    if (text.includes('private')) {
        return 403;
    }

    if (text.includes('sign in to confirm you\'re not a bot') || text.includes('http error 403')) {
        return 403;
    }

    if (text.includes('invalid argument') || text.includes('bad request') || text.includes('unable to download api page')) {
        return 400;
    }

    return 500;
}

async function prepareVideoFile(videoUrl, qualityLabel, onProgress) {
    const info = await getYtDlpInfo(videoUrl);
    const videoTitle = sanitizeFileName(info.title || 'video', 'video');
    const tempBasePath = createTempOutputBasePath();
    const outputTemplate = `${tempBasePath}.%(ext)s`;
    const formatSelector = buildVideoFormatSelector(qualityLabel);

    try {
        await runYtDlpCommand([
            '--no-playlist',
            '--no-part',
            '--newline',
            '--merge-output-format',
            'mp4',
            '-f',
            formatSelector,
            '-o',
            outputTemplate,
            videoUrl
        ], { onProgress });
    } catch (error) {
        const fallbackFormat = pickVideoFormat(info, qualityLabel);
        if (!fallbackFormat) {
            throw error;
        }

        await runYtDlpCommand([
            '--no-playlist',
            '--no-part',
            '--newline',
            '-f',
            fallbackFormat.format_id,
            '-o',
            outputTemplate,
            videoUrl
        ], { onProgress });
    }

    const tempFilePath = await resolveGeneratedOutputPath(tempBasePath);
    const extension = String(path.extname(tempFilePath) || '.mp4').replace('.', '').toLowerCase() || 'mp4';
    const fileName = `${videoTitle}.${extension}`;
    const contentType = getContentTypeByExtension(extension, 'video/mp4');

    return {
        filePath: tempFilePath,
        fileName,
        contentType
    };
}

async function prepareAudioFile(videoUrl, audioQuality, onProgress) {
    const info = await getYtDlpInfo(videoUrl);
    const rawTitle = sanitizeFileName(info.title || 'audio', 'audio');
    const qualityValue = getMp3QualityValue(audioQuality);
    const tempFilePath = createTempFilePath('mp3');

    try {
        await runYtDlpCommand([
            '--no-playlist',
            '--no-part',
            '--newline',
            '-f',
            'bestaudio/best',
            '-x',
            '--audio-format',
            'mp3',
            '--audio-quality',
            qualityValue,
            '-o',
            tempFilePath,
            videoUrl
        ], { onProgress });

        return {
            filePath: tempFilePath,
            fileName: `${rawTitle}.mp3`,
            contentType: 'audio/mpeg'
        };
    } catch (error) {
        await removeFileQuietly(tempFilePath);
        throw error;
    }
}

async function processDownloadJob(jobId, payload) {
    const job = downloadJobs.get(jobId);
    if (!job) {
        return;
    }

    try {
        const onProgress = (progress) => {
            const normalized = clampNumber(Math.round(progress), 1, 99);
            const current = downloadJobs.get(jobId);
            if (!current) {
                return;
            }

            if (normalized <= current.progress && current.status === 'preparing') {
                return;
            }

            updateDownloadJob(jobId, {
                status: 'preparing',
                progress: normalized,
                message: `Preparing file on server... ${normalized}%`
            });
        };

        let prepared;
        if (payload.type === 'video') {
            prepared = await prepareVideoFile(payload.link, payload.qualityLabel, onProgress);
        } else {
            prepared = await prepareAudioFile(payload.link, payload.audioQuality, onProgress);
        }

        const stat = await fsp.stat(prepared.filePath);

        updateDownloadJob(jobId, {
            status: 'ready',
            progress: 100,
            message: 'File is ready to download',
            filePath: prepared.filePath,
            fileName: prepared.fileName,
            contentType: prepared.contentType,
            fileSize: stat.size,
            expiresAt: Date.now() + READY_JOB_TTL_MS
        });
    } catch (error) {
        const message = getPublicYtDlpErrorMessage(error?.message || 'Internal Server Error');
        updateDownloadJob(jobId, {
            status: 'error',
            message: 'Failed to prepare file',
            error: message,
            expiresAt: Date.now() + ERROR_JOB_TTL_MS
        });
    }
}

router.post('/download-jobs', async (req, res) => {
    cleanupExpiredJobs().catch(() => undefined);

    const payload = req.body || {};
    const type = payload.type;
    const link = payload.link;

    if (type !== 'audio' && type !== 'video') {
        return res.status(400).json({ error: 'type must be audio or video' });
    }

    if (!link) {
        return res.status(400).json({ error: 'link is required' });
    }

    if (type === 'video' && !payload.qualityLabel) {
        return res.status(400).json({ error: 'qualityLabel is required for video jobs' });
    }

    const job = createDownloadJob(type);

    res.status(202).json({ jobId: job.id });

    processDownloadJob(job.id, {
        type,
        link,
        qualityLabel: payload.qualityLabel,
        audioQuality: payload.audioQuality || 'AUDIO_QUALITY_MEDIUM'
    }).catch((error) => {
        console.error('Failed to process download job:', error.message);
    });
});

router.get('/download-jobs/:jobId', async (req, res) => {
    await cleanupExpiredJobs();

    const job = downloadJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Download job not found' });
    }

    return res.status(200).json(getPublicDownloadJob(job));
});

router.get('/download-jobs/:jobId/file', async (req, res) => {
    await cleanupExpiredJobs();

    const job = downloadJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Download job not found' });
    }

    if (job.status === 'error') {
        return res.status(409).json({ error: job.error || 'Download preparation failed' });
    }

    if (job.status !== 'ready') {
        return res.status(409).json({ error: 'File is not ready yet', status: job.status, progress: job.progress });
    }

    if (!job.filePath || !job.fileName || !job.contentType) {
        return res.status(404).json({ error: 'Prepared file is missing' });
    }

    let fileStat;
    try {
        fileStat = await fsp.stat(job.filePath);
    } catch (_) {
        return res.status(404).json({ error: 'Prepared file is missing' });
    }

    updateDownloadJob(job.id, {
        status: 'downloading',
        message: 'Downloading to browser...',
        progress: 100,
        expiresAt: Date.now() + DOWNLOADING_JOB_TTL_MS
    });

    res.setHeader('Content-Disposition', buildContentDisposition(job.fileName));
    res.setHeader('Content-Type', job.contentType);
    res.setHeader('Content-Length', String(fileStat.size));

    let finalized = false;
    const finalize = async () => {
        if (finalized) {
            return;
        }

        finalized = true;

        await removeFileQuietly(job.filePath);
        downloadJobs.delete(job.id);
    };

    res.once('finish', () => {
        finalize().catch((error) => {
            console.error('Failed to finalize download job:', error.message);
        });
    });

    res.once('close', () => {
        finalize().catch((error) => {
            console.error('Failed to finalize download job:', error.message);
        });
    });

    const stream = fs.createReadStream(job.filePath);
    stream.on('error', (error) => {
        console.error('File stream error:', error.message);

        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to send prepared file' });
        } else {
            res.destroy(error);
        }
    });

    stream.pipe(res);
});

router.get('/search-video-audio', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        const info = await getYtDlpInfo(url);

        const qualityOptions = buildVideoQualityOptions(info.formats || []);
        if (qualityOptions.length === 0) {
            return res.status(404).json({ error: "Can't find any downloadable video qualities for this video" });
        }

        const youtube = qualityOptions.map((option) => ({
            link: url,
            qualityLabel: option.qualityLabel,
            image: info.thumbnail || null,
            height: option.height,
            audioQuality: 'AUDIO_QUALITY_MEDIUM'
        }));

        res.status(200).json({
            title: info.title || 'Unknown Title',
            youtube
        });
    } catch (error) {
        console.error(error);
        const message = getPublicYtDlpErrorMessage(error?.message || 'Internal Server Error');
        const status = getYtDlpErrorStatus(error?.message || message);
        res.status(status).json({ error: message });
    }
});

router.get('/search-audio', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        const info = await getYtDlpInfo(url, ['--extract-audio']);

        const arrayAudio = info.formats.filter((fmt) => {
            if (!fmt.url) return false;
            if (fmt.vcodec !== 'none') return false;
            if (isManifestProtocol(fmt.protocol)) return false;
            const note = (fmt.format_note || '').toLowerCase();
            if (note.includes('storyboard')) return false;
            return true;
        });

        if (arrayAudio.length === 0) {
            return res.status(404).json({ error: "Can't find any valid audio formats for this video" });
        }

        const bestAudio = arrayAudio.reduce((best, current) => {
            if (!best) return current;
            const bestAbr = best.abr || 0;
            const currAbr = current.abr || 0;
            return currAbr > bestAbr ? current : best;
        }, null);

        const youtubeAudio = [{
            link: url,
            url: bestAudio.url,
            mimeType: bestAudio.mime_type?.split(';')[0] || getContentTypeByExtension(bestAudio.ext, 'audio/mpeg'),
            audioQuality: bestAudio.audio_quality || 'AUDIO_QUALITY_MEDIUM'
        }];

        res.status(200).json({
            title: info.title || 'Unknown Title',
            youtubeAudio
        });
    } catch (error) {
        console.error(error);
        const message = getPublicYtDlpErrorMessage(error?.message || 'Internal Server Error');
        const status = getYtDlpErrorStatus(error?.message || message);
        res.status(status).json({ error: message });
    }
});

router.get('/search-playlist', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        const playlistId = url.split('list=')[1]?.split('&')[0];
        if (!playlistId) {
            return res.status(400).json({ error: 'Invalid Playlist URL' });
        }

        const playlistInfo = await getYtDlpSingleJson(url, ['--flat-playlist', '--playlist-end', '50', '--ignore-errors']);
        const entries = Array.isArray(playlistInfo.entries) ? playlistInfo.entries : [];

        if (entries.length === 0) {
            return res.status(404).json({ error: 'Playlist has no videos' });
        }

        const youtubePlaylist = [];
        let unavailableCount = 0;

        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            const videoUrl = buildPlaylistEntryUrl(entry);
            const unavailableByMeta = isPlaylistEntryUnavailable(entry);
            const available = Boolean(videoUrl) && !unavailableByMeta;
            const unavailableReason = !videoUrl
                ? 'Video URL is not available in this playlist item'
                : (unavailableByMeta ? getPlaylistEntryUnavailableReason(entry) : null);

            const item = {
                title: entry?.title || 'Unknown Title',
                image: entry?.thumbnails?.[0]?.url || (entry?.id ? `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg` : null),
                index: entry?.playlist_index || index + 1,
                duration: formatPlaylistDuration(entry?.duration),
                id: entry?.id || 'Unknown',
                url: videoUrl,
                titleLength: entry?.title?.length || 0,
                qualityLabels: available ? PLAYLIST_DEFAULT_QUALITY_LABELS : [],
                available,
                unavailableReason
            };

            if (!available) {
                unavailableCount += 1;
            }

            youtubePlaylist.push(item);
        }

        const unavailableSuffix = unavailableCount > 0
            ? ` (${unavailableCount} unavailable)`
            : '';

        res.status(200).json({
            title: `${entries.length} - ${playlistInfo.title || 'Unknown Playlist'}${unavailableSuffix}`,
            youtube: youtubePlaylist
        });
    } catch (error) {
        console.error(error);
        const message = getPublicYtDlpErrorMessage(error?.message || 'Internal Server Error');
        const status = getYtDlpErrorStatus(error?.message || message);
        res.status(status).json({ error: message });
    }
});

router.get('/download-video', async (req, res) => {
    let prepared = null;

    try {
        const videoUrl = req.query.link;
        const qualityLabel = req.query.qualityLabel;

        if (!videoUrl || !qualityLabel) {
            return res.status(400).json({ error: 'Both link and qualityLabel parameters are required' });
        }

        prepared = await prepareVideoFile(videoUrl, qualityLabel);
        await sendTempFile(res, prepared.filePath, prepared.fileName, prepared.contentType);
        prepared = null;
    } catch (error) {
        console.error(error);
        const message = getPublicYtDlpErrorMessage(error?.message || 'Internal Server Error');

        if (prepared?.filePath) {
            await removeFileQuietly(prepared.filePath);
        }

        if (!res.headersSent) {
            res.status(getYtDlpErrorStatus(error?.message || message)).json({ error: message });
        }
    }
});

router.get('/download-audio', async (req, res) => {
    let prepared = null;

    try {
        const videoUrl = req.query.link;
        const audioQuality = req.query.audioQuality;

        if (!videoUrl) {
            return res.status(400).json({ error: 'link query parameter is required' });
        }

        prepared = await prepareAudioFile(videoUrl, audioQuality || 'AUDIO_QUALITY_MEDIUM');
        await sendTempFile(res, prepared.filePath, prepared.fileName, prepared.contentType);
        prepared = null;
    } catch (error) {
        console.error(error);
        const message = getPublicYtDlpErrorMessage(error?.message || 'Internal Server Error');

        if (prepared?.filePath) {
            await removeFileQuietly(prepared.filePath);
        }

        if (!res.headersSent) {
            res.status(getYtDlpErrorStatus(error?.message || message)).json({ error: message });
        }
    }
});

module.exports = router;
