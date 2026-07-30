import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Giá curated theo (projectKey, partId) — nhiều dòng mỗi part để so sánh nhà cung cấp.
// `source` để ngỏ cho job đồng bộ giá tự động qua API nhà cung cấp điện tử sau này
// (ghi "api" thay vì "manual") mà không cần đổi schema.
export const vendorPrices = sqliteTable("vendor_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectKey: text("project_key").notNull(),
  partId: text("part_id").notNull(),
  vendorName: text("vendor_name").notNull(),
  url: text("url").notNull().default(""),
  price: real("price").notNull(),
  currency: text("currency").notNull().default("USD"),
  inStock: integer("in_stock", { mode: "boolean" }).notNull().default(true),
  note: text("note").notNull().default(""),
  source: text("source", { enum: ["manual", "api"] }).notNull().default("manual"),
  checkedAt: text("checked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Một lần người dùng triển khai thật một project template, có ngân sách riêng.
export const builds = sqliteTable("builds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectKey: text("project_key").notNull(),
  name: text("name").notNull(),
  budgetCap: real("budget_cap"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  buildId: integer("build_id").notNull().references(() => builds.id),
  vendorName: text("vendor_name").notNull(),
  orderedAt: text("ordered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  receivedAt: text("received_at"),
  trackingNumber: text("tracking_number").notNull().default(""),
  status: text("status", { enum: ["pending", "ordered", "shipped", "received", "cancelled"] }).notNull().default("pending"),
  shippingCost: real("shipping_cost").notNull().default(0),
});

export const orderItems = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  partId: text("part_id").notNull(),
  qty: integer("qty").notNull(),
  unitPrice: real("unit_price").notNull(),
});
