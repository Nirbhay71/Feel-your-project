// A private folder: Next never routes it, so Feel must not list it.
export async function GET() {
  return Response.json({ private: true });
}
