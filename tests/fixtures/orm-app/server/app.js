import express from 'express';
import orders from './routes/orders.js';
import customers from './routes/customers.js';

const app = express();
app.use('/api', orders);
app.use('/api/customers', customers);

export default app;
