// Must be the FIRST import: it patches Express and pg before any routes or
// database code is loaded. (ES imports run in order.)
import '@feel/node/register';

import express from 'express';
import statsRoutes from './routes/stats.js';
import salesRoutes from './routes/sales.js';
import notificationRoutes from './routes/notifications.js';
import orderRoutes from './routes/orders.js';

const app = express();

app.use('/api', statsRoutes, salesRoutes, notificationRoutes, orderRoutes);

const PORT = 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
