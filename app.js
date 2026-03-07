const express = require('express');
const indexRouter = require('./routes/index');
const cors = require('cors');
const app = express();
require('dotenv').config();

const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const trustProxy = String(process.env.TRUST_PROXY || 'true').toLowerCase() !== 'false';

if (trustProxy) {
    app.set('trust proxy', true);
}

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(null, false);
    },
    exposedHeaders: ['Content-Disposition', 'Content-Length']
}));

app.get('', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'ytbdn-api',
        front: process.env.FRONT_URL || null
    });
});

app.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'ytbdn-api'
    });
});

app.use('/api', indexRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`YTBDN API listening on port ${port}`);
});
