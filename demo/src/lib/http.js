import axios from 'axios';

// Shared axios instance — every call through it is prefixed with /api.
export const api = axios.create({ baseURL: '/api' });
