import type { OrderStatus } from "@/modules/orders";
import type { NormalizedFulfillmentStatus } from "./provider";

export const FO_RANK: Record<string, number> = {
  pending: 0,
  exported: 1,
  submitted: 1,
  accepted: 2,
  in_production: 3,
  packed: 4,
  shipped: 5,
};

export const ORDER_FOR_FO: Partial<Record<NormalizedFulfillmentStatus, OrderStatus>> = {
  accepted: "accepted",
  in_production: "in_production",
  packed: "packed",
  shipped: "shipped",
};

export const ORDER_RANK: Partial<Record<OrderStatus, number>> = {
  submitted: 1,
  accepted: 2,
  in_production: 3,
  packed: 4,
  shipped: 5,
  in_transit: 6,
  delivered: 7,
};
