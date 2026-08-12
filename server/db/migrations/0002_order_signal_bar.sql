ALTER TABLE orders ADD COLUMN signal_bar_at BIGINT;

CREATE INDEX idx_orders_pending_signal
  ON orders(session_id, status, signal_bar_at);
