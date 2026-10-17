-- 0002: record how a filled position finally ended (reported by the EA when it closes).
-- Additive: new nullable columns only; existing rows are untouched.
ALTER TABLE executions ADD COLUMN close_price REAL;
ALTER TABLE executions ADD COLUMN profit REAL;
ALTER TABLE executions ADD COLUMN closed_at INTEGER;
ALTER TABLE executions ADD COLUMN close_reason TEXT;
