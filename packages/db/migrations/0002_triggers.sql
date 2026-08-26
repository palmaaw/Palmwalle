-- Integrity triggers: the ledger is append-only, balances move only through it,
-- transaction core fields are immutable, and status transitions follow a strict
-- state machine. These make entire BUG CLASSES unrepresentable in SQL rather than
-- trusting every future caller.

-- Ledger entries apply themselves to wallet balances on insert. An overdrafting
-- debit violates wallet_accounts' CHECK(balance >= 0), which aborts the INSERT,
-- the enclosing statement, and therefore the whole transaction.
CREATE TRIGGER ledger_apply_debit AFTER INSERT ON ledger_entries
WHEN NEW.direction = 'debit'
BEGIN
  UPDATE wallet_accounts
     SET balance_piasters = balance_piasters - NEW.amount_piasters,
         updated_at = NEW.created_at
   WHERE id = NEW.account_id;
END;

CREATE TRIGGER ledger_apply_credit AFTER INSERT ON ledger_entries
WHEN NEW.direction = 'credit'
BEGIN
  UPDATE wallet_accounts
     SET balance_piasters = balance_piasters + NEW.amount_piasters,
         updated_at = NEW.created_at
   WHERE id = NEW.account_id;
END;

-- Append-only enforcement.
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- Transaction core fields are frozen after creation; only status/settlement/
-- failure columns may change.
CREATE TRIGGER txn_core_immutable BEFORE UPDATE ON transactions
WHEN OLD.id != NEW.id
  OR OLD.type != NEW.type
  OR OLD.human_ref != NEW.human_ref
  OR OLD.amount_piasters != NEW.amount_piasters
  OR OLD.currency != NEW.currency
  OR OLD.parent_transaction_id IS NOT NEW.parent_transaction_id
BEGIN
  SELECT RAISE(ABORT, 'transaction core fields are immutable');
END;

-- Status state machine: pending -> completed|failed; completed -> reversed.
-- Everything else is an illegal transition.
CREATE TRIGGER txn_status_transition BEFORE UPDATE OF status ON transactions
WHEN NOT (
      (OLD.status = 'pending' AND NEW.status IN ('completed', 'failed'))
   OR (OLD.status = 'completed' AND NEW.status = 'reversed')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal transaction status transition');
END;
