-- 0003_plan_step_bindings.sql
--
-- A tool step's input can take values from earlier steps' outputs (`ToolCall.bindings`), so a plan
-- can fetch a page and then summarize what it fetched. The bindings are part of the plan a human
-- approved, so they are stored with it: a plan read back after a restart that had lost them would
-- run its later steps on inputs missing the values they were planned to receive.
--
-- jsonb rather than a table: a binding is three pointers that mean nothing outside their step, and
-- the plan is only ever read whole. Effect Schema checks each binding's shape and that it reads
-- from an earlier step; the database holds the coarse invariants.

ALTER TABLE plan_step ADD COLUMN tool_bindings jsonb;

ALTER TABLE plan_step ADD CONSTRAINT plan_step_tool_bindings_shape CHECK (
  tool_bindings IS NULL
  OR (kind = 'tool' AND jsonb_typeof(tool_bindings) = 'array' AND jsonb_array_length(tool_bindings) > 0)
);
