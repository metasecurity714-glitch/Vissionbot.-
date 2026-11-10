CREATE TABLE IF NOT EXISTS students (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 roll_no TEXT NOT NULL UNIQUE,
 department TEXT NOT NULL,
 face_descriptors TEXT,
 thumbnail TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 subject TEXT NOT NULL,
 started_at TEXT NOT NULL,
 ended_at TEXT
);
CREATE TABLE IF NOT EXISTS attendance (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 client_uuid TEXT NOT NULL UNIQUE,
 session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('present','absent')),
 marked_at TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'kiosk',
 UNIQUE(session_id,student_id)
);
