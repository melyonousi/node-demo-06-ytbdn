const express = require('express');
const router = express.Router();
const ytdl = require('ytdl-core');
const ytpl = require('ytpl');

router.get('/search-video-audio', async (req, res) => {
    try {
        const url = ytdl.getURLVideoID(req.query.url)
        const info = await ytdl.getInfo(url);
        const images = info.player_response.microformat.playerMicroformatRenderer.thumbnail.thumbnails
        const array = info.player_response.streamingData.formats
        const youtube = []
        array.forEach(item => {
            youtube.push({
                link: req.query.url,
                url: item.url,
                qualityLabel: item.qualityLabel,
                image: images.slice(-1)[0].url,
                itag: item.itag,
                quality: item.quality,
                audioQuality: item.audioQuality
            })
        });

        if (array.length <= 0) {
            res.status(404).json({ error: "Can't Find a video" })
        } else {
            res.status(200).json({
                title: info.player_response.videoDetails.title,
                youtube
            })
        }
    } catch (error) {
        res.status(404).json({ error: error })
    }
});

router.get('/search-audio', async (req, res) => {
    try {
        const url = req.query.url
        const info = await ytdl.getInfo(ytdl.getURLVideoID(url));
        const arrayAudio = info.player_response.streamingData.adaptiveFormats.filter(item => item.mimeType.includes('audio/mp4'));
        const youtubeAudio = [];
        arrayAudio.forEach((item) => {
            youtubeAudio.push({
                link: url,
                url: item.url,
                mimeType: item.mimeType.split(';')[0],
                audioQuality: item.audioQuality
            });
        });
        res.status(200).json({ title: info.player_response.videoDetails.title, youtubeAudio })
    } catch (error) {
        res.status(404).json({ error: error })
    }
});

router.get('/search-playlist', async (req, res) => {
    try {
        const urlytpl = (req.query.url).split("list=")[1].split("&")[0]
        if (ytpl.validateID(urlytpl)) {
            const playlist = await ytpl(urlytpl, { pages: 50 });
            let youtubeplaylist = []
            for (const item of playlist.items) {
                const qualityLabels = (await ytdl.getInfo(item.id)).player_response.streamingData.formats
                youtubeplaylist.push({
                    title: item.title,
                    image: item.bestThumbnail.url,
                    index: item.index,
                    duration: item.duration,
                    id: item.id,
                    url: item.shortUrl,
                    titleLength: item.title.length,
                    qualityLabels: qualityLabels
                })
            };
            res.status(200).json({ title: `${playlist.estimatedItemCount} - ${playlist.title}`, youtube: youtubeplaylist })
        } else { res.status(404).json({ error: 'Playlist Not Found' }) }
    } catch (error) { res.status(404).json({ error: error.message }) }
})

router.get('/download-video', async (req, res) => {
    try {
        const videoUrl = req.query.link;
        const qualityLabel = req.query.qualityLabel;
        const videoId = ytdl.getURLVideoID(videoUrl);
        const info = await ytdl.getInfo(videoId);
        const videoTitle = info.videoDetails.title;

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(videoTitle)}.mp4"`);

        const format = ytdl.chooseFormat(info.formats,
            {
                quality: 'highest',
                filter: format => format.qualityLabel === qualityLabel &&
                    format.hasAudio &&
                    format.hasAudio
            });

        if (format.contentLength) {
            res.setHeader('Content-Length', format.contentLength);
        }
        ytdl(videoUrl, { format: format }).pipe(res);

    } catch (error) {
        res.status(400).json({ title: 'Failed to fetch video info or the video is not available.' })
    }
});

router.get('/download-audio', async (req, res) => {
    try {
        const videoUrl = req.query.link
        const audioQuality = req.query.audioQuality
        const videoId = ytdl.getVideoID(videoUrl);
        const data = await ytdl.getInfo(videoId);
        const videoTitle = data.videoDetails.title;

        const audioFormats = ytdl.filterFormats(data.formats, 'audioonly');

        const audioFormat = ytdl.chooseFormat(audioFormats, {
            quality: 'highestaudio',
            filter: (format) => format.hasAudio && format.audioQuality === audioQuality,
        });

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(videoTitle)}.mp3"`);
        res.setHeader('Content-Type', 'audio/mp3');
        if (audioFormat.contentLength) {
            res.setHeader('Content-Length', audioFormat.contentLength);
        }

        ytdl(videoUrl, { format: audioFormat }).pipe(res);
    } catch (error) {
        res.status(404).json({ title: error.message })
    }
});

module.exports = router;