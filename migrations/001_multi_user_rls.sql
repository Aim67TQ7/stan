-- ============================================================
-- STAN Multi-User with Row Level Security
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Add user_id to existing tasks table
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users;

-- Index for RLS performance
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON public.tasks(user_id);

-- 2. Create scheduled_tasks table
CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users NOT NULL,
  title text NOT NULL,
  description text,
  assigned_to text,
  schedule text NOT NULL,
  task_type text,
  payload jsonb DEFAULT '{}',
  enabled boolean DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_id ON public.scheduled_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON public.scheduled_tasks(next_run_at)
  WHERE enabled = true;

-- 3. Create agent_activity table
CREATE TABLE IF NOT EXISTS public.agent_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users,
  agent_name text NOT NULL,
  task_id uuid,
  action text NOT NULL,
  details jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_user_id ON public.agent_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON public.agent_activity(created_at DESC);

-- ============================================================
-- 4. Enable Row Level Security on all tables
-- ============================================================

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_status ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. RLS Policies — tasks (user sees/manages their own)
-- ============================================================

CREATE POLICY "tasks_select_own" ON public.tasks
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "tasks_insert_own" ON public.tasks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "tasks_update_own" ON public.tasks
  FOR UPDATE USING (auth.uid() = user_id);

-- ============================================================
-- 6. RLS Policies — agent_activity (user sees their own)
-- ============================================================

CREATE POLICY "activity_select_own" ON public.agent_activity
  FOR SELECT USING (auth.uid() = user_id);

-- ============================================================
-- 7. RLS Policies — scheduled_tasks (full CRUD for own)
-- ============================================================

CREATE POLICY "scheduled_select_own" ON public.scheduled_tasks
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "scheduled_insert_own" ON public.scheduled_tasks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "scheduled_update_own" ON public.scheduled_tasks
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "scheduled_delete_own" ON public.scheduled_tasks
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- 8. RLS Policies — agent_status (shared read for all authenticated)
-- ============================================================

CREATE POLICY "status_select_authenticated" ON public.agent_status
  FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================================
-- 9. Default user_id on insert (auto-set from session)
-- ============================================================

ALTER TABLE public.tasks
  ALTER COLUMN user_id SET DEFAULT auth.uid();

ALTER TABLE public.agent_activity
  ALTER COLUMN user_id SET DEFAULT auth.uid();

-- scheduled_tasks already has NOT NULL on user_id,
-- but set default for convenience
ALTER TABLE public.scheduled_tasks
  ALTER COLUMN user_id SET DEFAULT auth.uid();
