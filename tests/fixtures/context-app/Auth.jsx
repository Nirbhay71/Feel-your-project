import { createContext, useContext as readContext, useCallback } from 'react';

const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const login = useCallback(async () => fetch('/api/login', { method: 'POST' }), []);
  const profile = async () => fetch('/api/profile');
  return <AuthContext.Provider value={{ login, profile }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => {
  const value = readContext(AuthContext);
  if (!value) throw new Error('Provider missing');
  return value;
};

// A hook returning an ordinary object is not evidence of a context provider.
export const useOther = () => ({ login: () => fetch('/api/unrelated') });
