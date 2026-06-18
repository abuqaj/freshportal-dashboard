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
};

export type FixEntry = { product_id: string; name: string; old_vbn: string; new_vbn: string };

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
