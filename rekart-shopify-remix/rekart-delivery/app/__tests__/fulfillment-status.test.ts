import { describe, it, expect } from "vitest";

import {
  REKART_STATUSES,
  isRekartStatus,
  mapStatus,
  describeAction,
} from "../fulfillment-status";

describe("Rekart -> Shopify status mapping", () => {
  it("maps every Rekart status to a labelled action", () => {
    for (const status of REKART_STATUSES) {
      const action = mapStatus(status);
      expect(action).toBeTruthy();
      expect(typeof action.label).toBe("string");
    }
  });

  it("matches the documented Shopify action for each status", () => {
    expect(describeAction(mapStatus("confirmed"))).toBe("create_fulfillment");
    expect(describeAction(mapStatus("packed"))).toBe("create_fulfillment");
    expect(describeAction(mapStatus("ready_to_ship"))).toBe("event:IN_TRANSIT");
    expect(describeAction(mapStatus("shipped"))).toBe("event:IN_TRANSIT");
    expect(describeAction(mapStatus("delivered"))).toBe("event:DELIVERED");
    expect(describeAction(mapStatus("failed"))).toBe("event:FAILURE");
    expect(describeAction(mapStatus("cancelled"))).toBe("cancel_order");
    expect(describeAction(mapStatus("return_collected"))).toBe("event:ATTEMPTED_DELIVERY");
  });

  it("validates status strings defensively", () => {
    expect(isRekartStatus("delivered")).toBe(true);
    expect(isRekartStatus("shipped")).toBe(true);
    // Old statuses are no longer accepted.
    expect(isRekartStatus("out_for_delivery")).toBe(false);
    expect(isRekartStatus("nope")).toBe(false);
    expect(isRekartStatus("")).toBe(false);
    expect(isRekartStatus(null)).toBe(false);
    expect(isRekartStatus(123)).toBe(false);
  });
});
