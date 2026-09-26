// Must be the FIRST import: it patches Express before any routes are defined.
// (ES imports run in order, so the route files below are already patched.)
import '@feel/express/register';

import express from 'express';
import statsRoutes from './routes/stats.js';
import salesRoutes from './routes/sales.js';
import notificationRoutes from './routes/notifications.js';

const app = express();

app.use('/api', statsRoutes, salesRoutes, notificationRoutes);

const PORT = 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
