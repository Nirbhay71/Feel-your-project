import { usersApi } from './api.js';

export function Users() {
  usersApi.list();
  return null;
}
