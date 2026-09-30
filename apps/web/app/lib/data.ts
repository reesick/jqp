import { cache } from "react";
import { getDashboardStats } from "@jqp/publisher";

/**
 * Per-request memoised stats. The layout's sidebar and the page both need the
 * same aggregate; React's cache() makes them share one set of queries instead
 * of each paying a round trip to the database.
 */
export const getStats = cache(getDashboardStats);
