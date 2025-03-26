const express = require('express');
const router = express.Router();
const ytpl = require('ytpl');
const { exec, spawn } = require('child_process');

/**
 * Helper function to execute yt-dlp commands and parse JSON output.
 */
function getYtDlpInfo(url, extraOptions = []) {
    return new Promise((resolve, reject) => {
        // --dump-json prints JSON metadata about the video
        const args = ['--dump-json', ...extraOptions, url];
        exec(`yt-dlp ${args.join(' ')}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`yt-dlp error: ${stderr || error.message}`);
                return reject(new Error(stderr || error.message));
            }
            try {
                const parsed = JSON.parse(stdout);
                resolve(parsed);
            } catch (parseError) {
                console.error(`Failed to parse yt-dlp output: ${stdout}`);
                reject(new Error('Failed to parse yt-dlp output'));
            }
        });
    });
}

/**
 * Search for “progressive” video+audio formats of a YouTube video.
 * (These are typically MP4 or WebM formats that contain both audio+video.)
 * 
 * MODIFIED to pick exactly one “best” format if available, based on resolution, then tbr.
 */
router.get('/search-video-audio', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        const info = await getYtDlpInfo(url);

        // Filter for formats that have both video and audio (i.e., not “vcodec: none” or “acodec: none”)
        // We also skip “storyboard” or purely manifest-based formats (no direct .url).
        const filtered = info.formats.filter(fmt => {
            if (!fmt.url) return false; // must have a direct url
            if (fmt.vcodec === 'none' || fmt.acodec === 'none') return false; // skip separate streams
            const note = (fmt.format_note || '').toLowerCase();
            if (note.includes('storyboard')) return false; // skip storyboard/preview tracks
            return true;
        });

        if (filtered.length === 0) {
            return res.status(404).json({ error: "Can't find any progressive video+audio formats for this video" });
        }

        // Pick the single “best” format by highest resolution (height), then highest tbr
        const bestFormat = filtered.reduce((best, current) => {
            if (!best) return current;

            const bestHeight = best.height || 0;
            const currentHeight = current.height || 0;
            if (currentHeight > bestHeight) return current;
            if (currentHeight < bestHeight) return best;

            // If heights are equal, compare tbr (total bitrate)
            const bestTbr = best.tbr || 0;
            const currentTbr = current.tbr || 0;
            return currentTbr > bestTbr ? current : best;
        }, null);

        const youtube = [{
            link: url,
            url: bestFormat.url,
            qualityLabel: bestFormat.format_note || bestFormat.quality_label || 'Unknown',
            image: info.thumbnail || null,
            itag: bestFormat.format_id,
            quality: bestFormat.quality || 'Unknown',
            height: bestFormat.height || 'Unknown',
            tbr: bestFormat.tbr || 'Unknown'
        }];

        res.status(200).json({
            title: info.title || 'Unknown Title',
            youtube,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

/**
 * Search specifically for audio‐only formats of a YouTube video.
 * We allow DASH/HLS to appear, as “yt-dlp -x” can still extract it.
 * 
 * MODIFIED to pick exactly one “best” format if available.
 */
router.get('/search-audio', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        // Use --extract-audio so that yt-dlp includes audio-only details
        const info = await getYtDlpInfo(url, ['--extract-audio']);

        // Filter to keep only “audio‐only” streams (vcodec === 'none') that have a valid URL
        // We also skip storyboards or anything lacking a direct .url
        const arrayAudio = info.formats.filter(fmt => {
            if (!fmt.url) return false;
            if (fmt.vcodec !== 'none') return false; // must be purely audio
            const note = (fmt.format_note || '').toLowerCase();
            if (note.includes('storyboard')) return false;
            return true;
        });

        if (arrayAudio.length === 0) {
            return res.status(404).json({ error: "Can't find any valid audio formats for this video" });
        }

        // Pick the single “best” audio by highest abr (bitrate), if abr is defined.
        const bestAudio = arrayAudio.reduce((best, current) => {
            if (!best) return current;
            const bestAbr = best.abr || 0;
            const currAbr = current.abr || 0;
            return currAbr > bestAbr ? current : best;
        }, null);

        // Return exactly one item in youtubeAudio
        const youtubeAudio = [{
            link: url,
            url: bestAudio.url,
            mimeType: bestAudio.mime_type?.split(';')[0] || 'Unknown',
            audioQuality: bestAudio.audio_quality || 'Unknown'
        }];

        res.status(200).json({
            title: info.title || 'Unknown Title',
            youtubeAudio
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

/**
 * Search for videos in a YouTube playlist.
 * For each item, we fetch metadata using getYtDlpInfo as well.
 */
router.get('/search-playlist', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        const playlistId = url.split("list=")[1]?.split("&")[0];
        if (!playlistId || !ytpl.validateID(playlistId)) {
            return res.status(400).json({ error: 'Invalid Playlist URL' });
        }

        // Fetch the playlist
        const playlist = await ytpl(playlistId, { pages: 50 });
        const youtubePlaylist = [];

        // For each video, fetch its formats
        for (const item of playlist.items) {
            const videoInfo = await getYtDlpInfo(item.shortUrl);
            youtubePlaylist.push({
                title: item.title || 'Unknown Title',
                image: item.bestThumbnail?.url || null,
                index: item.index || 0,
                duration: item.duration || 'Unknown',
                id: item.id || 'Unknown',
                url: item.shortUrl || null,
                titleLength: item.title?.length || 0,
                // Include the raw “formats” array so you can do further filtering on the front end if desired
                qualityLabels: videoInfo.formats || []
            });
        }

        res.status(200).json({
            title: `${playlist.estimatedItemCount || 0} - ${playlist.title || 'Unknown Playlist'}`,
            youtube: youtubePlaylist
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

/**
 * Download a specific progressive video format (MP4, etc.).
 * Expects link=? and qualityLabel=? in the query string.
 */
router.get('/download-video', async (req, res) => {
    try {
        const videoUrl = req.query.link;
        const qualityLabel = req.query.qualityLabel;

        if (!videoUrl || !qualityLabel) {
            return res
                .status(400)
                .json({ error: 'Both link and qualityLabel parameters are required' });
        }

        const info = await getYtDlpInfo(videoUrl);
        const videoTitle = info.title || 'video';

        // For “progressive” downloads, find a format whose format_note or quality_label matches `qualityLabel`
        // Also ensure it has both vcodec and acodec
        const chosen = info.formats.find(
            f =>
                (f.format_note === qualityLabel || f.quality_label === qualityLabel) &&
                f.vcodec !== 'none' &&
                f.acodec !== 'none'
        );

        if (!chosen) {
            return res
                .status(404)
                .json({ error: `Requested quality (${qualityLabel}) not found` });
        }

        // Set response headers so the browser treats this as a file download
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(videoTitle)}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');
        if (chosen.filesize) {
            res.setHeader('Content-Length', chosen.filesize);
        }

        // Stream directly from yt-dlp’s stdout
        const ytDlpProcess = spawn('yt-dlp', ['-f', chosen.format_id, '-o', '-', videoUrl]);

        ytDlpProcess.stdout.pipe(res);

        ytDlpProcess.stderr.on('data', data => {
            console.error(`yt-dlp stderr: ${data.toString()}`);
        });

        ytDlpProcess.on('error', err => {
            console.error(`yt-dlp process error: ${err.message}`);
            res.status(500).json({ error: 'Failed to start yt-dlp process' });
        });

        ytDlpProcess.on('close', code => {
            if (code !== 0) {
                console.error(`yt-dlp process exited with code ${code}`);
                res.status(500).json({ error: 'Failed to download video' });
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

router.get('/download-audio', async (req, res) => {
    try {
        const videoUrl = req.query.link;
        if (!videoUrl) {
            return res.status(400).json({ error: 'link query parameter is required' });
        }

        // 1) Get metadata, so we can provide a nice filename for the user.
        const info = await getYtDlpInfo(videoUrl);
        const rawTitle = info.title || 'audio';
        // We'll URI-encode the title to make it safe for Content-Disposition.
        const fileName = encodeURIComponent(rawTitle.trim()) + '.mp3';

        // 2) Instruct the browser to download an MP3 file attachment.
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        // Note: We do NOT set Content-Length because after transcoding,
        // the final MP3 size isn’t known in advance.

        // 3) Spawn yt-dlp to extract/transcode the audio to MP3, outputting to stdout.
        const ytDlpProcess = spawn('yt-dlp', [
            '-x',
            '--audio-format', 'mp3',
            '-o', '-',
            videoUrl
        ]);

        // 4) Pipe the audio bytes directly to the response (the user's browser).
        ytDlpProcess.stdout.pipe(res);

        // 5) Log errors from yt-dlp if any.
        ytDlpProcess.stderr.on('data', (chunk) => {
            console.error('yt-dlp stderr:', chunk.toString());
        });

        // 6) Handle process-level errors.
        ytDlpProcess.on('error', (err) => {
            console.error('yt-dlp process error:', err.message);
            // If not already sent, send 500 to user.
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to start yt-dlp' });
            }
        });

        // 7) When yt-dlp finishes, check for non-zero exit codes.
        ytDlpProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`yt-dlp process exited with code ${code}`);
                // If we haven't sent anything yet, respond with 500
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Audio extraction failed' });
                }
            }
            // Otherwise, the stream ended successfully and the download is complete.
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

module.exports = router;