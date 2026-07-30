"use client";

// Mỗi "build" là một lần người dùng triển khai thật một project template, có ngân
// sách riêng và lịch sử đơn hàng — tách khỏi dữ liệu template tĩnh trong lib/*-data.ts.
// App chưa có tài khoản người dùng nên build gắn theo trình duyệt (localStorage),
// đây là giới hạn MVP single-user, không phải lỗi.

import { useEffect, useState } from "react";
import type { ProjectPart } from "@/lib/project-export";

type Build = { id: number; projectKey: string; name: string; budgetCap: number | null; createdAt: string };
type Order = { id: number; buildId: number; vendorName: string; orderedAt: string; receivedAt: string | null; trackingNumber: string; status: string; shippingCost: number };
type OrderItem = { id: number; orderId: number; partId: string; qty: number; unitPrice: number };
type OrderWithItems = { order: Order; items: OrderItem[] };

const STATUS_LABEL: Record<string, string> = { pending: "Chờ đặt", ordered: "Đã đặt", shipped: "Đang giao", received: "Đã nhận", cancelled: "Đã huỷ" };

function storageKey(projectKey: string) {
  return `diy-build-${projectKey}`;
}

function readBuildId(projectKey: string) {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(storageKey(projectKey));
  return stored ? Number(stored) : null;
}

export function PurchasingView({ projectKey, parts, projectedTotal }: { projectKey: string; parts: ProjectPart[]; projectedTotal: number }) {
  const [trackedProjectKey, setTrackedProjectKey] = useState(projectKey);
  const [buildId, setBuildId] = useState<number | null>(() => readBuildId(projectKey));
  const [build, setBuild] = useState<Build | null>(null);
  const [actualSpend, setActualSpend] = useState(0);
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  if (projectKey !== trackedProjectKey) {
    setTrackedProjectKey(projectKey);
    setBuildId(readBuildId(projectKey));
    setBuild(null);
    setActualSpend(0);
    setOrders([]);
  }
  const [buildName, setBuildName] = useState("");
  const [budgetCapInput, setBudgetCapInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [vendorName, setVendorName] = useState("");
  const [shippingCost, setShippingCost] = useState("0");
  const [draftItems, setDraftItems] = useState<Array<{ partId: string; qty: number; unitPrice: number }>>([]);
  const [pickedPartId, setPickedPartId] = useState(parts[0]?.id ?? "");
  const [pickedQty, setPickedQty] = useState("1");
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [orderError, setOrderError] = useState("");

  const readErrorMessage = async (response: Response) => {
    const payload = await response.json().catch(() => ({}));
    return payload.error || `Yêu cầu thất bại (${response.status})`;
  };

  const loadBuild = (id: number) => {
    fetch(`/api/builds?id=${id}`).then((response) => response.json()).then((payload) => {
      if (payload.build) { setBuild(payload.build); setActualSpend(payload.actualSpend ?? 0); }
    });
    fetch(`/api/orders?buildId=${id}`).then((response) => response.json()).then((payload) => {
      if (Array.isArray(payload.orders)) setOrders(payload.orders);
    });
  };

  useEffect(() => { if (buildId) loadBuild(buildId); }, [buildId]);

  const startBuild = () => {
    if (!buildName.trim()) return;
    setCreating(true);
    setCreateError("");
    const budgetCap = budgetCapInput.trim() ? Number(budgetCapInput) : null;
    fetch("/api/builds", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey, name: buildName.trim(), budgetCap }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const payload = await response.json();
      window.localStorage.setItem(storageKey(projectKey), String(payload.build.id));
      setBuildId(payload.build.id);
    }).catch((error) => setCreateError(error instanceof Error ? error.message : "Không tạo được build."))
      .finally(() => setCreating(false));
  };

  const addDraftItem = () => {
    const part = parts.find((item) => item.id === pickedPartId);
    const qty = Number(pickedQty);
    if (!part || !Number.isFinite(qty) || qty <= 0) return;
    setDraftItems((items) => [...items, { partId: part.id, qty, unitPrice: part.price }]);
  };

  const submitOrder = () => {
    if (!buildId || !vendorName.trim() || draftItems.length === 0) return;
    setSubmittingOrder(true);
    setOrderError("");
    fetch("/api/orders", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ buildId, vendorName: vendorName.trim(), shippingCost: Number(shippingCost) || 0, items: draftItems }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(await readErrorMessage(response));
      setVendorName(""); setShippingCost("0"); setDraftItems([]); loadBuild(buildId);
    }).catch((error) => setOrderError(error instanceof Error ? error.message : "Không tạo được đơn hàng."))
      .finally(() => setSubmittingOrder(false));
  };

  const markReceived = (orderId: number) => {
    fetch("/api/orders", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId, status: "received", receivedAt: new Date().toISOString() }),
    }).then(() => buildId && loadBuild(buildId));
  };

  if (!buildId || !build) {
    return <div className="purchasing-page">
      <section className="purchasing-start">
        <h2>Bắt đầu theo dõi mua hàng cho build này</h2>
        <p>Tạo một build để theo dõi ngân sách thật và lịch sử đặt hàng riêng cho lần triển khai này.</p>
        <label>Tên build<input value={buildName} onChange={(event) => setBuildName(event.target.value)} placeholder="VD: Build lần 1 - lớp 10A" /></label>
        <label>Ngân sách tối đa (USD, tuỳ chọn)<input type="number" min="0" step="1" value={budgetCapInput} onChange={(event) => setBudgetCapInput(event.target.value)} placeholder={projectedTotal.toFixed(0)} /></label>
        <button disabled={creating || !buildName.trim()} onClick={startBuild}>{creating ? "Đang tạo…" : "Bắt đầu build"}</button>
        {createError && <p className="purchasing-error">{createError}</p>}
      </section>
    </div>;
  }

  const cap = build.budgetCap ?? projectedTotal;
  const ratio = cap > 0 ? actualSpend / cap : 0;
  const budgetState = ratio >= 1 ? "over" : ratio >= 0.9 ? "warn" : "ok";

  return <div className="purchasing-page">
    <section className="purchasing-budget">
      <div className="budget-head"><h2>{build.name}</h2><span>DỰ KIẾN ${projectedTotal.toFixed(2)}</span></div>
      <div className={`budget-bar budget-${budgetState}`}><i style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
      <div className="budget-figures">
        <span><small>ĐÃ CHI THẬT</small><b>${actualSpend.toFixed(2)}</b></span>
        <span><small>NGÂN SÁCH</small><b>${cap.toFixed(2)}</b></span>
        {budgetState === "over" && <em className="budget-warning">Đã vượt ngân sách</em>}
        {budgetState === "warn" && <em className="budget-warning">Gần chạm ngân sách</em>}
      </div>
    </section>

    <section className="purchasing-orders">
      <h2>ĐƠN HÀNG</h2>
      {orders.length === 0 ? <p className="empty-detail">Chưa có đơn hàng nào.</p> : <div className="orders-table">
        {orders.map(({ order, items }) => {
          const subtotal = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0) + order.shippingCost;
          return <div className="order-row" key={order.id}>
            <div><b>{order.vendorName}</b><small>{items.length} part · {order.trackingNumber || "chưa có mã vận đơn"}</small></div>
            <span className={`order-status status-${order.status}`}>{STATUS_LABEL[order.status] ?? order.status}</span>
            <b>${subtotal.toFixed(2)}</b>
            {order.status !== "received" && order.status !== "cancelled" && <button onClick={() => markReceived(order.id)}>Đã nhận</button>}
          </div>;
        })}
      </div>}
    </section>

    <section className="purchasing-new-order">
      <h2>THÊM ĐƠN HÀNG</h2>
      <div className="new-order-form">
        <input placeholder="Nhà cung cấp" value={vendorName} onChange={(event) => setVendorName(event.target.value)} />
        <input placeholder="Phí ship USD" type="number" min="0" step="0.01" value={shippingCost} onChange={(event) => setShippingCost(event.target.value)} />
      </div>
      <div className="new-order-item-picker">
        <select value={pickedPartId} onChange={(event) => setPickedPartId(event.target.value)}>
          {parts.map((part) => <option key={part.id} value={part.id}>{part.name} — ${part.price.toFixed(2)}</option>)}
        </select>
        <input type="number" min="1" step="1" value={pickedQty} onChange={(event) => setPickedQty(event.target.value)} />
        <button type="button" onClick={addDraftItem}>+ Thêm part</button>
      </div>
      {draftItems.length > 0 && <ul className="draft-items">
        {draftItems.map((item, index) => {
          const part = parts.find((candidate) => candidate.id === item.partId);
          return <li key={`${item.partId}-${index}`}>{part?.name ?? item.partId} × {item.qty} — ${(item.qty * item.unitPrice).toFixed(2)}</li>;
        })}
      </ul>}
      <button disabled={submittingOrder || !vendorName.trim() || draftItems.length === 0} onClick={submitOrder}>{submittingOrder ? "Đang lưu…" : "Tạo đơn hàng"}</button>
      {orderError && <p className="purchasing-error">{orderError}</p>}
    </section>
  </div>;
}
