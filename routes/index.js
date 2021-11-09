var express = require('express');
var router = express.Router();
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
        for (let i = 0; i < images.length; i++) {
            image = images[i].url
        }

        const array = info.player_response.streamingData.formats
        let youtube = []
        for (let i = 0; i < array.length; i++) {
            youtube.push({
                url: array[i].url,
                label: array[i].qualityLabel,
                image: image
            })
        }
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

    // let format = ytdl.chooseFormat(info.formats, { quality: '134' });



    // res.send({
    //         info: {
    //             title: info.player_response.videoDetails.title,
    //             image: image
    //         },
    //         info: youtube
    //     })


    // res.header("Content-Disposition", 'attachment;\  filename="Video.mp4"');
    // ytdl(url, { filter: format => format.container === 'mp4' }).pipe(res);
});

// router.get('/download', async(req, res) => {
//     window.location.href = req.query.url
//         // res.header("Content-Disposition", 'attachment;\  filename="Video.mp4"');
//         // ytdl(req.query.url).pipe(res);
// });

module.exports = router;