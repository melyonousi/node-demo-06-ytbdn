const express = require('express');
const { format } = require('morgan');
const router = express.Router();
const ytdl = require('ytdl-core');
const ytpl = require('ytpl');

/* GET home page. */
router.get('/', function (req, res, next) {
    res.render('index', { title: 'YTBDN (Youtube Downloader Video)' });
});

router.get('/search', async (req, res) => {
    try {
        const url = ytdl.getURLVideoID(req.query.url)
        const info = await ytdl.getInfo(url);

        const images = info.player_response.microformat.playerMicroformatRenderer.thumbnail.thumbnails
        let image = ''
        images.forEach(item => {
            image = item.url
        })

        const arrayAudio = info.player_response.streamingData.adaptiveFormats.filter(item => { return item.mimeType.includes('audio/mp4') })
        let youtubeAudio = []
        arrayAudio.forEach(item => {
            youtubeAudio.push({
                link: req.query.url,
                url: item.url,
                mimeType: item.mimeType.split(';')[0],
                audioQuality: item.audioQuality
            })
        });

        const array = info.player_response.streamingData.formats
        let youtube = []
        array.forEach(item => {
            youtube.push({
                link: req.query.url,
                url: item.url,
                qualityLabel: item.qualityLabel,
                image: image,
                itag: item.itag,
                quality: item.quality,
            })
        });

        res.render("index", {
            title: `YTBDN (${info.player_response.videoDetails.title})`,
            youtube: youtube,
            youtubeAudio: youtubeAudio
        })
    } catch (error) {
        res.render("index", {
            title: 'YTBDN (URL youtube video not found, please past a valid youtube URL).',
        })
    }
});

router.get('/playlist', async (req, res) => {
    res.render('playlist', { title: 'YTBDN (Youtube Downloader Playlist)' })
})

router.get('/searchplaylist', async (req, res) => {
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

            res.render('playlist',
                {
                    title: `YTBDN ${playlist.title} (${playlist.estimatedItemCount})`,
                    count: playlist.estimatedItemCount,
                    playlistUrl: playlist.url,
                    youtube: youtubeplaylist
                })
        } else {
            res.render('playlist', { title: 'YTBDN (playlist not found)' })
        }
    } catch (error) {
        res.render('playlist', { title: 'YTBDN (playlist not found)' })
    }
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
        ytdl(videoUrl, { format: format }).pipe(res);

    } catch (error) {
        res.render('index', { title: 'Failed to fetch video info or the video is not available.' });
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

        ytdl(videoUrl, { format: audioFormat }).pipe(res);
    } catch (error) {
        res.render('index', { title: 'Failed to fetch aduio info or the aduio is not available.' });
    }
});

module.exports = router;