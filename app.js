const express = require('express');
const indexRouter = require('./routes/index');
const cors = require('cors')
const app = express();
require('dotenv').config()

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(cors())

app.get('', (req, res) => {
    res.redirect(process.env.FRONT_URL)
})
app.use('/api', indexRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});