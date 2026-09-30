// POST /api/items/:id — rename one item through Drizzle.
import { eq } from 'drizzle-orm';
import { db } from '../../../../lib/db';
import { items } from '../../../../lib/schema';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await db.update(items).set({ name: 'renamed' }).where(eq(items.id, Number(id))).returning();
  return Response.json({ item: rows[0] ?? null });
}
