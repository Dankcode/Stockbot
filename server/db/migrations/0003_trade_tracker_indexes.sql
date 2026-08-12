CREATE INDEX idx_orders_account_time
  ON orders(account_id, submitted_at, id);

CREATE INDEX idx_fills_time
  ON fills(filled_at, id);

CREATE INDEX idx_lots_account_time
  ON position_lots(account_id, opened_at, id);
