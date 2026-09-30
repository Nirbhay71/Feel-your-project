// GET /api/stats — inside a (group) folder, which isn't part of the URL.
export async function GET() {
  return Response.json({ ok: true });
}
