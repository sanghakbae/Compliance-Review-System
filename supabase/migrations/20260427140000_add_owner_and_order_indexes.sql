create index if not exists idx_policy_documents_owner_created
  on public.policy_documents (owner_user_id, created_at desc);

create index if not exists idx_policy_documents_workspace_created
  on public.policy_documents (workspace_id, created_at desc);

create index if not exists idx_policy_document_sections_version_order
  on public.policy_document_sections (document_version_id, hierarchy_order);

create index if not exists idx_policy_law_sources_owner_created
  on public.policy_law_sources (owner_user_id, created_at desc);

create index if not exists idx_policy_law_sources_workspace_created
  on public.policy_law_sources (workspace_id, created_at desc);

create index if not exists idx_policy_law_versions_source_effective_created
  on public.policy_law_versions (law_source_id, effective_date desc, created_at desc);

create index if not exists idx_policy_comparison_runs_actor_created
  on public.policy_comparison_runs (actor_user_id, created_at desc);
