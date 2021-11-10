const express = require('express');
const router = express.Router();
const ytdl = require('ytdl-core');
const ytpl = require('ytpl');

/* GET home page. */
router.get('/', function(req, res, next) {
    res.render('index', { title: 'YTBDN (Youtube Downloader Video)' });
});

router.get('/search', async(req, res) => {
    try {
        const url = ytdl.getURLVideoID(req.query.url)
        const info = await ytdl.getInfo(url);

        const images = info.player_response.microformat.playerMicroformatRenderer.thumbnail.thumbnails
        let image = ''
        images.forEach(item => {
            image = item.url
        })

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
            youtube: youtube
        })
    } catch (error) {
        res.render("index", {
            title: 'YTBDN (URL youtube video not found, please past a valid youtube URL).',
        })
    }
});

router.get('/playlist', async(req, res) => {
    res.render('playlist', { title: 'YTBDN (Youtube Downloader Playlist)' })
})

router.get('/searchplaylist', async(req, res) => {
    try {
        const urlytpl = (req.query.url).split("list=")[1].split("&")[0]
        if (await ytpl.validateID(urlytpl)) {
            const playlist = await ytpl(urlytpl, { pages: 50 });
            let youtubeplaylist = []

            playlist.items.forEach(item => {
                youtubeplaylist.push({
                    image: item.bestThumbnail.url,
                    title: item.title,
                    index: item.index,
                    id: item.id,
                    duration: item.duration,
                    url: item.shortUrl,
                    titleLength: item.title.length
                })
            });
            res.render('playlist', { title: `YTBDN (${playlist.title} '${playlist.estimatedItemCount}')`, count: playlist.estimatedItemCount, playlistUrl: playlist.url, youtube: youtubeplaylist })
        } else {
            res.render('playlist', { title: 'YTBDN (playlist not found)' })
        }
    } catch (error) {
        res.render('playlist', { title: 'YTBDN (playlist not found)' })
    }
})

router.get('/download', async(req, res) => {

    const infos = {
        link: req.query.link,
    }
    res.header("Content-Disposition", 'attachment;\  filename="' + ytdl.getURLVideoID(infos.link) + '.mp4"');
    const info = await ytdl.getInfo(infos.link);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
    ytdl(infos.link, { format: format }).pipe(res);
});

module.exports = router;