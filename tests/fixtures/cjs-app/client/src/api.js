import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// "API object" style: methods grouped per resource.
export const itemsApi = {
  list: () => api.get('/items'),
  get: (id) => api.get(`/items/${id}`),
};

export const usersApi = {
  list: () => api.get('/users'),
};
