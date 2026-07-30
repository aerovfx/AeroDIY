import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { builds, orderItems, orders } from "@/db/schema";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Lỗi không xác định";
  const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;
  if (combined.includes("no such table") || combined.includes('from "builds"')) {
    return "Bảng builds chưa sẵn sàng. Chạy `npm run db:generate` rồi deploy để nền tảng áp migration vào D1 thật.";
  }
  return message;
}

const postSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(1),
  budgetCap: z.number().positive().nullable().default(null),
});

export async function POST(request: Request) {
  try {
    const input = postSchema.parse(await request.json());
    const db = getDb();
    const [build] = await db.insert(builds).values(input).returning();
    return Response.json({ build }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Dữ liệu build không hợp lệ." }, { status: 400 });
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const idParam = searchParams.get("id");
    if (!idParam) return Response.json({ error: "id là bắt buộc" }, { status: 400 });
    const id = Number(idParam);

    const db = getDb();
    const [build] = await db.select().from(builds).where(eq(builds.id, id));
    if (!build) return Response.json({ error: "Không tìm thấy build" }, { status: 404 });

    const buildOrders = await db.select().from(orders).where(eq(orders.buildId, id));
    const items = await Promise.all(buildOrders.map((order) => db.select().from(orderItems).where(eq(orderItems.orderId, order.id))));
    const itemsTotal = items.flat().reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
    const shippingTotal = buildOrders.reduce((sum, order) => sum + order.shippingCost, 0);
    const actualSpend = Number((itemsTotal + shippingTotal).toFixed(2));

    return Response.json({ build, orders: buildOrders, actualSpend });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
