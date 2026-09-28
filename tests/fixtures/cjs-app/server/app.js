// A CommonJS Express app in the style most real projects use.
const express = require('express');

const app = express();
const users = require('./routes/users');

app.use('/api/items', require('./routes/items')); // required inline
app.use('/api/users', users); // required into a variable

module.exports = app;
