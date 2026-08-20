-- Fixed-asset accounting เฟส 2: journal entry ทุกรายการต้องสมดุลกัน
-- (sum(debit) = sum(credit) ทุก line ของมัน) — บังคับใน createJournalEntry
-- ของ journalEntriesStore.ts ไม่ใช่ DB constraint เพราะ Postgres เช็ค
-- aggregate ข้าม child rows ตอน insert ได้ยากถ้าไม่มี deferred trigger การ
-- บังคับที่ฝั่งแอปตรงตามธรรมเนียมเดิมของ schema นี้ที่ "กฎ status/รูปแบบอยู่
-- ใน zod ไม่ใช่ CHECK constraint" reverses_entry_id เป็น self-FK: entry ที่
-- ใช้กลับรายการจะชี้กลับไปยัง entry ที่มันล้างค่า (ดู reverseJournalEntry ใน
-- journalEntriesStore.ts)
CREATE TABLE IF NOT EXISTS journal_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  entry_date        DATE NOT NULL,
  fiscal_year       INTEGER NOT NULL,
  source            TEXT NOT NULL,
  source_id         TEXT,
  description       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'posted',
  reverses_entry_id UUID REFERENCES journal_entries(id),
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_org ON journal_entries (org_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_fiscal_year ON journal_entries (org_id, fiscal_year);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id  UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES organizations(id),
  account_id        UUID NOT NULL REFERENCES gl_accounts(id),
  debit             NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit            NUMERIC(14,2) NOT NULL DEFAULT 0,
  memo              TEXT
);

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_entry ON journal_entry_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_account ON journal_entry_lines (account_id);
