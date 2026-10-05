// Response shapes of the /bi-sync/* endpoints the Analysis Tool reads
// (python/api_server.py, db.py). Volumes are stems, prices € per stem.

export interface SyncRun {
  status: string;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  mutation_from: string | null;
  messages?: string[];
}

export interface SyncHistory {
  history: SyncRun[];
  stats: {
    stock_entry_dim_count?: number;
    offers_online_today?: number;
    order_lines_count?: number;
    invoice_customer_count?: number;
  } | null;
  running: boolean;
}

export interface Totals { stems: number; value: number; price: number | null; lines: number; products: number }
export interface Ranked { key: string; label: string; stems: number; value: number }

export interface Overview {
  current: Totals | null;
  previous: Totals | null;
  previous_range: [string, string] | null;
  daily: { day: string; stems: number; value: number }[];
  top_products: Ranked[];
  top_suppliers: Ranked[];
}

export interface OfferDaily {
  days: { day: string; lots: number; stems: number; sold_out: number }[];
  data_from: string | null;
}

export interface OfferVsSale {
  lengths: {
    length: number;
    points: { day: string; offer?: number; offer_lots?: number; sale?: number; sale_stems?: number }[];
  }[];
  data_from: string | null;
  transport: number;
}

export interface PriceMatch {
  lines: number;
  stems?: number;
  at_offer_pct?: number;
  below_pct?: number;
  above_pct?: number;
  median_deviation?: number;
  bins: { cents: number; stems: number }[];
  data_from: string | null;
}

export interface SellThrough {
  rows: { key: string; label: string; sold: number; left: number; offered: number; pct: number; listings: number; sold_out: number }[];
  total: { sold: number; offered: number; pct: number | null; listings: number; sold_out: number } | null;
  data_from: string | null;
}

export interface SelloutSpeed {
  products: {
    product_id: string; label: string; hours: number[];
    lots: { hours: number; supplier: string | null; length: number | null }[];
    median_hours: number | null; listings: number; sold_out: number;
  }[];
  data_from: string | null;
}

export interface SoldOutLots {
  rows: {
    stock_entry_id: string; product: string; supplier: string | null; length: number | null;
    price: number | null; sold_out_at: string | null; hours: number | null; stems: number;
  }[];
  data_from: string | null;
}

export interface ProductListings {
  rows: {
    stock_entry_id: string; supplier: string | null; length: number | null; price: number | null;
    available_from: string | null; available_until: string | null; sold_out_at: string | null;
    hours: number | null; sold: number; offered: number;
  }[];
  data_from: string | null;
}

export interface IdleLots {
  rows: {
    stock_entry_id: string; product: string; supplier_id: string | null; supplier: string; length: number | null;
    price: number | null; days_online: number; stems: number; stems_per_box: number | null; available_until: string | null;
  }[];
  min_days: number;
  data_from: string | null;
}

export interface SeriesPoint { day: string; value: number; quantity: number }
export interface Series { key: string; label: string; points: SeriesPoint[] }

export interface TopProduct { product_id: string; label: string; quantity: number; value: number; line_count: number }

export interface LengthPoint {
  length: number; avg_price: number; avg_supplier_price: number | null;
  spread_pct: number | null; quantity: number; line_count: number;
}

export interface Elasticity {
  points: { period: string; price: number; quantity: number; excluded: boolean }[];
  elasticity: number | null;
  intercept: number | null;
  r2: number | null;
  periods: number;
  price_range_pct: number | null;
  reliable: boolean;
  min_periods: number;
  min_price_range_pct: number;
}

export interface SupplierPrice {
  supplier_id: string; name: string; avg_price: number; min_price: number; max_price: number; quantity: number; line_count: number;
}

export interface Volatility {
  points: { supplier_id: string; name: string; cv_pct: number | null; avg_price: number | null; line_count: number; product_count: number }[];
  total_suppliers?: number;
  excluded?: number;
}

export interface Deviation {
  points: { supplier_id: string; name: string; deviation_pct: number; avg_price: number; market_price: number; line_count: number }[];
  total_suppliers?: number;
  excluded?: number;
}

export interface Seasonality { years: { year: number; months: { month: number; quantity: number; price: number | null }[] }[] }

export interface EventImpact {
  events: {
    event: string;
    years: {
      year: number; volume_lift_pct: number | null; price_lift_pct: number | null;
      event_typical_quantity: number | null; baseline_typical_quantity: number | null;
      event_days: number; baseline_days: number;
    }[];
  }[];
}
