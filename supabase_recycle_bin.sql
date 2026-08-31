-- ==============================================================================
-- StaffEase Supabase Recycle Bin (Soft Delete & Data Recovery) Schema
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.recycle_bin (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    record_data JSONB NOT NULL,
    record_name TEXT,
    deleted_by TEXT,
    deleted_by_role TEXT DEFAULT 'admin',
    deleted_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB
);

-- Indexes for efficient querying by admin, table, and date
CREATE INDEX IF NOT EXISTS idx_recycle_bin_admin_id ON public.recycle_bin(admin_id);
CREATE INDEX IF NOT EXISTS idx_recycle_bin_table_name ON public.recycle_bin(table_name);
CREATE INDEX IF NOT EXISTS idx_recycle_bin_deleted_at ON public.recycle_bin(deleted_at DESC);

-- Enable RLS
ALTER TABLE public.recycle_bin ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to perform soft deletes & super admin to read/restore
CREATE POLICY "Allow authenticated read recycle_bin" ON public.recycle_bin
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated insert recycle_bin" ON public.recycle_bin
    FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Allow authenticated delete recycle_bin" ON public.recycle_bin
    FOR DELETE TO authenticated USING (true);
