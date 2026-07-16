-- Machine Data Tracker - D1 Schema
-- Run with: wrangler d1 execute machine-data-db --file=schema.sql

DROP TABLE IF EXISTS readings;
DROP TABLE IF EXISTS machines;
DROP TABLE IF EXISTS users;

-- People who can log in. role='admin' can manage machines/users via /admin.html
-- role='incharge' can only log readings.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin TEXT NOT NULL,        -- 4-digit PIN, keep simple for factory floor use
  role TEXT NOT NULL DEFAULT 'incharge' CHECK(role IN ('admin','incharge')),
  active INTEGER DEFAULT 1
);

-- 21 machines across 2 HMI brands. EDIT THIS LIST to match your real machines,
-- or manage it later from the /admin.html page instead of editing this file.
-- machine_type: 'Ishida' = "CCW Production / Total Data" screen (2 photos needed - it scrolls)
-- machine_type: 'Yamato' = "Auto Operation" dark-theme screen (1 photo needed)
CREATE TABLE machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_no TEXT NOT NULL UNIQUE,   -- e.g. "M-01"
  line_name TEXT,                    -- e.g. "Line 1"
  machine_type TEXT NOT NULL CHECK(machine_type IN ('Ishida','Yamato')),
  active INTEGER DEFAULT 1
);

-- One row per submitted reading
CREATE TABLE readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  machine_no TEXT NOT NULL,
  machine_type TEXT NOT NULL,
  shift TEXT NOT NULL CHECK(shift IN ('A','B','C')),
  incharge_name TEXT NOT NULL,
  reading_date TEXT NOT NULL,        -- YYYY-MM-DD, date the reading is logged for
  submitted_at TEXT NOT NULL,        -- ISO timestamp

  -- Normalized common fields (present on both machine brands, unified naming)
  target_weight_g REAL,
  total_weight_g REAL,
  average_weight_g REAL,
  efficiency_pct REAL,
  std_dev_g REAL,
  max_weight_g REAL,
  min_weight_g REAL,
  count_value INTEGER,               -- "Proper" (Ishida) or "Dump No." (Yamato)
  start_time TEXT,
  stop_time TEXT,

  -- Full raw extraction (every field the AI read, brand-specific extras included)
  raw_json TEXT,

  -- Photos in R2, comma-separated keys if more than one (Ishida needs 2 screens)
  photo_keys TEXT,

  -- Flag if incharge edited any AI-extracted value before submitting (data-quality signal)
  was_corrected INTEGER DEFAULT 0,

  -- Cloud double-check: 0 = only read by on-device OCR (offline capture), 1 = Groq has
  -- confirmed the values. cloud_mismatch lists any fields where Groq disagreed with the
  -- locally-read value, as JSON, for a supervisor to glance at.
  cloud_checked INTEGER DEFAULT 0,
  cloud_mismatch TEXT
);

CREATE INDEX idx_readings_date ON readings(reading_date);
CREATE INDEX idx_readings_machine ON readings(machine_id);
CREATE INDEX idx_readings_shift ON readings(shift);

-- Seed users - CHANGE THESE PINs before going live. Sidhartha is seeded as admin
-- so /admin.html works immediately; add real shift incharges via that page.
INSERT INTO users (name, pin, role) VALUES
  ('Sidhartha', '1234', 'admin'),
  ('Shift Incharge A', '1111', 'incharge'),
  ('Shift Incharge B', '2222', 'incharge'),
  ('Shift Incharge C', '3333', 'incharge');

-- Seed example machines - EDIT to match your real 21 machines, or add/edit them
-- later from /admin.html without touching this file again.
INSERT INTO machines (machine_no, line_name, machine_type) VALUES
  ('M-01', 'Line 1', 'Ishida'), ('M-02', 'Line 1', 'Ishida'), ('M-03', 'Line 1', 'Ishida'),
  ('M-04', 'Line 1', 'Ishida'), ('M-05', 'Line 1', 'Ishida'), ('M-06', 'Line 2', 'Ishida'),
  ('M-07', 'Line 2', 'Ishida'), ('M-08', 'Line 2', 'Ishida'), ('M-09', 'Line 2', 'Ishida'),
  ('M-10', 'Line 2', 'Ishida'), ('M-11', 'Line 2', 'Ishida'), ('M-12', 'Line 3', 'Ishida'),
  ('M-13', 'Line 3', 'Ishida'), ('M-14', 'Line 3', 'Ishida'), ('M-15', 'Line 3', 'Ishida'),
  ('M-16', 'Line 4', 'Yamato'), ('M-17', 'Line 4', 'Yamato'), ('M-18', 'Line 4', 'Yamato'),
  ('M-19', 'Line 4', 'Yamato'), ('M-20', 'Line 5', 'Yamato'), ('M-21', 'Line 5', 'Yamato');

-- Migration note: if you already deployed the earlier schema, don't re-run this whole file
-- (it would wipe your data). Instead run just these two lines against your live DB:
--   ALTER TABLE readings ADD COLUMN cloud_checked INTEGER DEFAULT 0;
--   ALTER TABLE readings ADD COLUMN cloud_mismatch TEXT;
