const express = require('express');
const indexRouter = require('./routes/index');
const cors = require('cors');
const app = express();
require('dotenv').config();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(cors({
    origin: true,
    exposedHeaders: ['Content-Disposition', 'Content-Length']
}));

app.get('', (req, res) => {
    res.status(200).json({ front: process.env.FRONT_URL });
});
app.use('/api', indexRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
