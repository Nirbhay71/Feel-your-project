// Root layout — a Server Component.
export const metadata = { title: 'Feel Next fixture' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
