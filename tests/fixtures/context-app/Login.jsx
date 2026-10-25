import { useAuth as useSession, useOther } from './Auth.jsx';
export function Login() {
  const { login: signIn } = useSession();
  return <button onClick={() => signIn()}>Sign in</button>;
}
export function Other() {
  const { login } = useOther();
  return <button onClick={() => login()}>Other</button>;
}
export function Reassigned() {
  let { login } = useSession();
  login = () => fetch('/api/local');
  return <button onClick={() => login()}>Local callback</button>;
}
