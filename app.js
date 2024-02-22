const express = require('express');
const indexRouter = require('./routes/index');
const cors = require('cors')
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(cors({
    origin: ['https://angular-demo-07-ytbdn.netlify.app', 'https://ytbdn.casetrue.com', 'http://localhost:4200']
}))

app.get('', (req, res) => {
    res.status(200).json({ success: 'YTBDN | Youtube Downloader' })
})
app.use('/api', indexRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});