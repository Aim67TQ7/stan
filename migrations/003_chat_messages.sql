-- ============================================================
-- STAN Chat Messages — persistent two-way conversation log
-- Every message (user→bot, bot→user, agent→user) is a row.
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Create chat_messages table
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users NOT NULL,
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'agent', 'system')),
  content text NOT NULL,
  agent text,                          -- which agent responded (sentry, magnus, clark, etc.)
  task_id uuid,                        -- links to tasks table if a task was spawned
  metadata jsonb DEFAULT '{}',         -- flexible: token usage, routing info, etc.
  created_at timestamptz DEFAULT now()
);

-- 2. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id
  ON public.chat_messages(user_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON public.chat_messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_task
  ON public.chat_messages(task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_created
  ON public.chat_messages(created_at DESC);

-- 3. Enable RLS
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies — users see only their own conversations
CREATE POLICY "chat_select_own" ON public.chat_messages
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "chat_insert_own" ON public.chat_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 5. Default user_id from session
ALTER TABLE public.chat_messages
  ALTER COLUMN user_id SET DEFAULT auth.uid();
