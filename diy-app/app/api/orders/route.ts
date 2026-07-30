import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { orderItems, orders } from "@/db/schema";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Lỗi không xác định";
  const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;
  if (combined.includes("no such table") || combined.includes('from "orders"')) {
    return "Bảng orders chưa sẵn sàng. Chạy `npm run db:generate` rồi deploy để nền tảng áp migration vào D1 thật.";
  }
  return message;
}

const postSchema = z.object({
  buildId: z.number().int().positive(),
  vendorName: z.string().min(1),
  shippingCost: z.number().nonnegative().default(0),
  items: z.array(z.object({
    partId: z.string().min(1),
    qty: z.number().int().positive(),
    unitPrice: z.number().nonnegative(),
  })).min(1),
});

const patchSchema = z.object({
  orderId: z.number().int().positive(),
  status: z.enum(["pending", "ordered", "shipped", "received", "cancelled"]).optional(),
  receivedAt: z.string().optional(),
  trackingNumber: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const input = postSchema.parse(await request.json());
    const db = getDb();
    const [order] = await db.insert(orders).values({
      buildId: input.buildId, vendorName: input.vendorName, shippingCost: input.shippingCost,
    }).returning();
    const items = await db.insert(orderItems).values(
      input.items.map((item) => ({ orderId: order.id, partId: item.partId, qty: item.qty, unitPrice: item.unitPrice })),
    ).returning();
    return Response.json({ order, items }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Dữ liệu đơn hàng không hợp lệ." }, { status: 400 });
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const buildIdParam = searchParams.get("buildId");
    if (!buildIdParam) return Response.json({ error: "buildId là bắt buộc" }, { status: 400 });
    const buildId = Number(buildIdParam);

    const db = getDb();
    const buildOrders = await db.select().from(orders).where(eq(orders.buildId, buildId));
    const withItems = await Promise.all(buildOrders.map(async (order) => ({
      order,
      items: await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
    })));
    return Response.json({ orders: withItems });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const input = patchSchema.parse(await request.json());
    const { orderId, ...changes } = input;
    if (Object.keys(changes).length === 0) return Response.json({ error: "Không có thay đổi nào" }, { status: 400 });

    const db = getDb();
    const [order] = await db.update(orders).set(changes).where(eq(orders.id, orderId)).returning();
    if (!order) return Response.json({ error: "Không tìm thấy đơn hàng" }, { status: 404 });
    return Response.json({ order });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Dữ liệu cập nhật không hợp lệ." }, { status: 400 });
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
