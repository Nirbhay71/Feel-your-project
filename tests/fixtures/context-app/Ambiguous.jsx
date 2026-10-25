import { createContext, useContext } from 'react';
const Context = createContext(null);
export const useAmbiguous = () => useContext(Context);
export function First({ children }) {
  const login = () => fetch('/api/first');
  return <Context.Provider value={{ login }}>{children}</Context.Provider>;
}
export function Second({ children }) {
  const login = () => fetch('/api/second');
  return <Context.Provider value={{ login }}>{children}</Context.Provider>;
}
export function Consumer() {
  const { login } = useAmbiguous();
  return <button onClick={() => login()}>Login</button>;
}
