const fs = require('fs')
const express = require('express');
const router = express.Router();
const ytdl = require('ytdl-core');

/* GET home page. */
router.get('/', function(req, res, next) {
    res.render('index', { title: 'Youtube Downloader' });
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
            title: info.player_response.videoDetails.title,
            image: image,
            youtube: youtube
        })
    } catch (error) {
        res.render("index", {
            title: 'URL youtube video not found, please past a valid youtube URL.',
        })
    }


});

router.get('/download', async(req, res) => {

    const infos = {
        link: req.query.link,
        itag: req.query.itag,
    }
    res.header("Content-Disposition", 'attachment;\  filename="' + ytdl.getURLVideoID(infos.link) + '.mp4"');
    const info = await ytdl.getInfo(infos.link);
    const format = ytdl.chooseFormat(info.formats, { quality: infos.itag });
    ytdl(infos.link, { format: format }).pipe(res);
});

module.exports = router;