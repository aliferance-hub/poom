"use client";

import { create } from "zustand";

type CartCountState = { count: number; set: (n: number) => void };

// Client UX mirror only — PostgreSQL Cart/CartItem is the source of truth.
// This store is intentionally NOT persisted; it hydrates from /api/cart.
export const useCartCount = create<CartCountState>((set) => ({
  count: 0,
  set: (count) => set({ count }),
}));
