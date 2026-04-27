alter table public.policy_review_execution_history
  add column if not exists ai_report_history_id uuid references public.policy_ai_report_history (id) on delete set null;

create index if not exists idx_policy_review_execution_history_ai_report
  on public.policy_review_execution_history (ai_report_history_id)
  where ai_report_history_id is not null;

with latest_review as (
  select id, owner_user_id
  from public.policy_review_execution_history
  where ai_report_history_id is null
    and result_status = 'ai_completed'
  order by created_at desc, id desc
  limit 1
),
latest_report as (
  select id, owner_user_id
  from public.policy_ai_report_history
  order by created_at desc, id desc
  limit 1
)
update public.policy_review_execution_history history
set ai_report_history_id = latest_report.id
from latest_review, latest_report
where history.id = latest_review.id
  and latest_review.owner_user_id = latest_report.owner_user_id;
