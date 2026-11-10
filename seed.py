import os
import sqlite3
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.environ.get("CLASSVISION_DB", os.path.join(BASE, "classvision.db"))
SCHEMA = os.path.join(BASE, "schema", "schema.sql")

STUDENTS = [
    ("Aarav Sharma", "CSE001", "Computer Science"),
    ("Diya Patel", "CSE002", "Computer Science"),
    ("Ishaan Das", "ME003", "Mechanical"),
    ("Ananya Rao", "EE004", "Electrical"),
    ("Kabir Singh", "CSE005", "Computer Science"),
]

os.makedirs(os.path.dirname(DB) or BASE, exist_ok=True)
with sqlite3.connect(DB) as conn:
    conn.execute("PRAGMA foreign_keys = ON")
    with open(SCHEMA, encoding="utf-8") as schema_file:
        conn.executescript(schema_file.read())

    for student in STUDENTS:
        conn.execute(
            "INSERT OR IGNORE INTO students(name,roll_no,department) VALUES(?,?,?)",
            student,
        )

    if conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0:
        now = datetime.now().replace(hour=9, minute=0, second=0, microsecond=0)
        stamp = now.isoformat(timespec="seconds")
        session_id = conn.execute(
            "INSERT INTO sessions(subject,started_at,ended_at) VALUES(?,?,?)",
            ("Introduction to Computing", stamp, stamp),
        ).lastrowid
        for roll_no in ("CSE001", "CSE002", "EE004"):
            student_id = conn.execute(
                "SELECT id FROM students WHERE roll_no=?", (roll_no,)
            ).fetchone()[0]
            conn.execute(
                """INSERT OR IGNORE INTO attendance
                (client_uuid,session_id,student_id,status,marked_at,source)
                VALUES(?,?,?,?,?,?)""",
                (f"seed-{session_id}-{roll_no}", session_id, student_id,
                 "present", stamp, "seed"),
            )

print("Seed complete: 5 dummy students and sample attendance.")
