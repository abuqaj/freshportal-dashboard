export type VbnResult = {
  product_id: string;
  short_name: string;
  name: string;
  current_vbn: string;
  official_name: string;
  status: "OK" | "ERROR" | "WARNING";
  reason: string;
  proposed_vbn: string;
  proposed_vbn_name: string;
  edited_vbn?: string;
  excluded?: boolean;
};

export type Stats = {
  total: number;
  errors: number;
  warnings: number;
  ok: number;
};

export type ProductSearchResult = {
  product_id: string;
  name: string;
  short_name: string;
  vbn_number: string;
  similarity: number;
  color?: string;
  product_group?: string;
  application?: string;
};

export type FixEntry = { product_id: string; name: string; old_vbn: string; new_vbn: string };

/** A product as FreshPortal shows it right after it was created. */
export type CreatedProduct = {
  product_id: string;
  name: string;
  product_number: string;
  vbn_number: string;
  color: string;
};

/** Something that differs from what was asked for, or could not be checked. */
export type CreateWarning = { code: string; expected?: string | null; actual?: string | null };

/**
 * Outcome of a product creation.
 *
 * created / created_with_warnings — found in FreshPortal after saving
 * unconfirmed  — save was clicked but the product could not be found; it may
 *                exist, so it must be checked before trying again
 * failed       — nothing was saved
 * blocked      — stopped before saving (invalid input, number taken, name in
 *                use, another creation running); the form stays open
 */
export type CreateResult = {
  status: "created" | "created_with_warnings" | "unconfirmed" | "failed" | "blocked";
  ok: boolean;
  name: string;
  product_number: string;
  product: CreatedProduct | null;
  product_url: string | null;
  search_url: string | null;
  warnings: CreateWarning[];
  reason: string | null;
  error_text: string | null;
  suggested_number: string | null;
  existing: CreatedProduct[];
};

export type AIAnalysis = {
  duplicate: {
    found: boolean;
    product_id?: string | null;
    product_name?: string | null;
    confidence?: string;
    reason?: string;
  };
  vbn: {
    code?: string | null;
    name?: string | null;
    confidence?: string;
    explanation?: string;
  };
};

export type PhotoUploadItem = { filename: string; product_name: string; status: string; message?: string };

export type HistoryRow = {
  id: number;
  type: string;
  vbn_filter: string | null;
  stats: Record<string, unknown> | null;
  details: {
    fixes?: FixEntry[];
    name?: string;
    product_number?: string;
    template_name?: string;
    template_id?: string;
    success?: boolean;
    status?: CreateResult["status"];
    reason?: string | null;
    product_id?: string | null;
    vbn_code?: string | null;
    color?: string | null;
    warnings?: string[];
    items?: PhotoUploadItem[];
  } | null;
  username: string | null;
  created_at: string;
};

export type SyncRun = {
  id: number;
  started_at: string;
  finished_at: string | null;
  product_count: number | null;
  status: string;
  error: string | null;
  messages: string[];
};

export type AutoVbnRun = {
  id: number;
  started_at: string;
  finished_at: string | null;
  checked_count: number | null;
  fixed_count: number | null;
  status: string;
  error: string | null;
  fixes: { product_id: string; name: string; old_vbn: string; new_vbn: string; ok: boolean }[];
  messages: string[];
};

export type SyncStatus = {
  running: boolean;
  product_count: number;
  last_sync: {
    started_at: string;
    finished_at: string | null;
    product_count: number | null;
    status: string;
  } | null;
};
