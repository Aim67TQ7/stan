-- Fix wake-stan-tasks trigger to fire on BOTH INSERT and UPDATE when status = 'inbox'
-- This ensures tasks that are re-queued (status changed back to 'inbox') also trigger STAN

DROP TRIGGER IF EXISTS "wake-stan-tasks" ON public.tasks;

CREATE TRIGGER "wake-stan-tasks"
AFTER INSERT OR UPDATE OF status ON public.tasks
FOR EACH ROW
WHEN (NEW.status = 'inbox')
EXECUTE FUNCTION supabase_functions.http_request(
  'http://187.77.28.22:3000/hook/new-task',
  'POST',
  '{"Content-type":"application/json"}',
  '{}',
  '5000'
);
