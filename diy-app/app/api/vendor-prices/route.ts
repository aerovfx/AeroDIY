import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { vendorPrices } from "@/db/schema";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Lỗi không xác định";
  const detail = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;
  if (combined.includes("no such table") || combined.includes('from "vendor_prices"')) {
    return "Bảng vendor_prices chưa sẵn sàng. Chạy `npm run db:generate` rồi deploy để nền tảng áp migration vào D1 thật.";
  }
  return message;
}

const postSchema = z.object({
  projectKey: z.string().min(1),
  partId: z.string().min(1),
  vendorName: z.string().min(1),
  url: z.string().default(""),
  price: z.number().nonnegative(),
  currency: z.string().default("USD"),
  inStock: z.boolean().default(true),
  note: z.string().default(""),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectKey = searchParams.get("projectKey");
    const partId = searchParams.get("partId");
    if (!projectKey || !partId) return Response.json({ error: "projectKey và partId là bắt buộc" }, { status: 400 });

    const db = getDb();
    const rows = await db.select().from(vendorPrices)
      .where(and(eq(vendorPrices.projectKey, projectKey), eq(vendorPrices.partId, partId)));
    return Response.json({ vendorPrices: rows });
  } catch (error) {
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const input = postSchema.parse(await request.json());
    const db = getDb();
    const existing = await db.select().from(vendorPrices).where(and(
      eq(vendorPrices.projectKey, input.projectKey),
      eq(vendorPrices.partId, input.partId),
      eq(vendorPrices.vendorName, input.vendorName),
    ));
    if (existing.length > 0) {
      const [row] = await db.update(vendorPrices).set({
        url: input.url, price: input.price, currency: input.currency,
        inStock: input.inStock, note: input.note,
      }).where(eq(vendorPrices.id, existing[0].id)).returning();
      return Response.json({ vendorPrice: row });
    }
    const [row] = await db.insert(vendorPrices).values(input).returning();
    return Response.json({ vendorPrice: row }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Dữ liệu giá không hợp lệ." }, { status: 400 });
    return Response.json({ error: toRouteErrorMessage(error) }, { status: 500 });
  }
}
