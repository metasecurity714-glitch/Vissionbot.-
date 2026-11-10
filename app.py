import io
import json
import os
import sqlite3
import uuid
from datetime import date, datetime

import pandas as pd
from flask import Flask, g, jsonify, render_template, request, send_file

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("CLASSVISION_DB", os.path.join(BASE, "classvision.db"))
SCHEMA = os.path.join(BASE, "schema", "schema.sql")
app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_error):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(DB) or BASE, exist_ok=True)
    with sqlite3.connect(DB) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        with open(SCHEMA, encoding="utf-8") as schema_file:
            conn.executescript(schema_file.read())


# Ensure tables also exist when started with `flask run` or imported by a WSGI server.
init_db()


@app.route("/")
def home():
    return render_template("dashboard.html")


@app.route("/students")
def students_page():
    return render_template("students.html")


@app.route("/kiosk")
def kiosk_page():
    return render_template("kiosk.html")


@app.route("/dashboard")
def dashboard_page():
    return render_template("dashboard.html")


@app.get("/api/students")
def students_list():
    rows = db().execute(
        "SELECT id,name,roll_no,department,thumbnail,face_descriptors FROM students ORDER BY name"
    ).fetchall()
    return jsonify([
        {
            "id": row["id"], "name": row["name"], "roll_no": row["roll_no"],
            "department": row["department"], "thumbnail": row["thumbnail"],
            "has_face": bool(row["face_descriptors"]),
        }
        for row in rows
    ])


@app.post("/api/students")
def student_add():
    data = request.get_json(silent=True) or {}
    name, roll, department = (
        str(data.get(key, "")).strip() for key in ("name", "roll_no", "department")
    )
    if not name or not roll or not department:
        return jsonify(error="Name, roll number and department are required."), 400
    try:
        cur = db().execute(
            "INSERT INTO students(name,roll_no,department) VALUES(?,?,?)",
            (name, roll, department),
        )
        db().commit()
        return jsonify(id=cur.lastrowid), 201
    except sqlite3.IntegrityError:
        return jsonify(error="That roll number already exists."), 409


@app.put("/api/students/<int:sid>/face")
def student_face(sid):
    data = request.get_json(silent=True) or {}
    descriptors = data.get("descriptors")
    thumbnail = data.get("thumbnail")
    if not isinstance(descriptors, list) or len(descriptors) != 5 or not thumbnail:
        return jsonify(error="Exactly five face descriptors and one thumbnail are required."), 400
    for descriptor in descriptors:
        if (not isinstance(descriptor, list) or len(descriptor) != 128
                or any(not isinstance(value, (int, float)) for value in descriptor)):
            return jsonify(error="Each descriptor must contain 128 numeric values."), 400
    cur = db().execute(
        "UPDATE students SET face_descriptors=?,thumbnail=? WHERE id=?",
        (json.dumps(descriptors, separators=(",", ":")), thumbnail, sid),
    )
    db().commit()
    if cur.rowcount == 0:
        return jsonify(error="Student not found."), 404
    return jsonify(ok=True)


@app.delete("/api/students/<int:sid>")
def student_delete(sid):
    cur = db().execute("DELETE FROM students WHERE id=?", (sid,))
    db().commit()
    if cur.rowcount == 0:
        return jsonify(error="Student not found."), 404
    return jsonify(ok=True)


@app.post("/api/faces/delete-all")
def delete_faces():
    db().execute("UPDATE students SET face_descriptors=NULL, thumbnail=NULL")
    db().commit()
    return jsonify(ok=True)


@app.get("/api/face-data")
def face_data():
    rows = db().execute(
        "SELECT id,name,roll_no,face_descriptors FROM students WHERE face_descriptors IS NOT NULL"
    ).fetchall()
    result = []
    for row in rows:
        try:
            descriptors = json.loads(row["face_descriptors"])
            if (not isinstance(descriptors, list) or len(descriptors) != 5
                    or any(not isinstance(item, list) or len(item) != 128 for item in descriptors)):
                continue
            result.append({
                "id": row["id"], "name": row["name"], "roll_no": row["roll_no"],
                "descriptors": descriptors,
            })
        except (TypeError, json.JSONDecodeError):
            continue
    return jsonify(result)


@app.post("/api/sessions")
def session_start():
    data = request.get_json(silent=True) or {}
    subject = str(data.get("subject", "")).strip()
    if not subject:
        return jsonify(error="Enter a subject name."), 400
    cur = db().execute(
        "INSERT INTO sessions(subject,started_at) VALUES(?,?)",
        (subject, datetime.now().isoformat(timespec="seconds")),
    )
    db().commit()
    return jsonify(id=cur.lastrowid, subject=subject), 201


@app.post("/api/sessions/<int:sid>/end")
def session_end(sid):
    cur = db().execute(
        "UPDATE sessions SET ended_at=COALESCE(ended_at,?) WHERE id=?",
        (datetime.now().isoformat(timespec="seconds"), sid),
    )
    db().commit()
    if cur.rowcount == 0:
        return jsonify(error="Session not found."), 404
    return jsonify(ok=True)


@app.get("/api/sessions")
def sessions_list():
    rows = db().execute(
        "SELECT id,subject,started_at,ended_at FROM sessions ORDER BY id DESC"
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/sync")
def sync_attendance():
    data = request.get_json(silent=True) or {}
    items = data.get("records", [])
    if not isinstance(items, list):
        return jsonify(error="Records must be a list."), 400
    saved = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            client_uuid = str(uuid.UUID(str(item["client_uuid"])))
            session_id = int(item["session_id"])
            student_id = int(item["student_id"])
            status = item.get("status", "present")
            marked_at = str(item.get("marked_at") or datetime.now().isoformat(timespec="seconds"))
            source = str(item.get("source", "kiosk"))
            if status not in ("present", "absent"):
                continue
            cur = db().execute(
                """INSERT OR IGNORE INTO attendance
                (client_uuid,session_id,student_id,status,marked_at,source)
                VALUES(?,?,?,?,?,?)""",
                (client_uuid, session_id, student_id, status, marked_at, source),
            )
            saved += cur.rowcount
        except (KeyError, ValueError, TypeError, sqlite3.IntegrityError):
            continue
    db().commit()
    return jsonify(saved=saved, received=len(items))


@app.get("/api/dashboard")
def dashboard_data():
    today = date.today().isoformat()
    conn = db()
    total = conn.execute("SELECT COUNT(*) FROM students").fetchone()[0]
    today_session_rows = conn.execute(
        "SELECT id FROM sessions WHERE date(started_at)=?", (today,)
    ).fetchall()
    session_ids = [row["id"] for row in today_session_rows]
    present = 0
    if session_ids:
        placeholders = ",".join("?" for _ in session_ids)
        present = conn.execute(
            f"""SELECT COUNT(DISTINCT student_id) FROM attendance
            WHERE status='present' AND session_id IN ({placeholders})""",
            session_ids,
        ).fetchone()[0]
    absent = max(total - present, 0)
    percentage = round((present / total) * 100, 1) if total else 0

    chart_rows = conn.execute(
        """SELECT s.subject, COUNT(DISTINCT a.student_id) AS count
        FROM sessions s LEFT JOIN attendance a
          ON a.session_id=s.id AND a.status='present'
        GROUP BY s.subject ORDER BY s.subject"""
    ).fetchall()
    total_sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    students = conn.execute(
        "SELECT id,name,roll_no,department FROM students ORDER BY name"
    ).fetchall()
    student_stats = []
    for student in students:
        attended = conn.execute(
            "SELECT COUNT(*) FROM attendance WHERE student_id=? AND status='present'",
            (student["id"],),
        ).fetchone()[0]
        rate = round(attended / total_sessions * 100, 1) if total_sessions else 0
        student_stats.append({
            "id": student["id"], "name": student["name"],
            "roll_no": student["roll_no"], "department": student["department"],
            "percentage": rate,
        })

    return jsonify(
        total=total, present=present, absent=absent, percentage=percentage,
        subjects=[row["subject"] for row in chart_rows],
        counts=[row["count"] for row in chart_rows], students=student_stats,
    )


@app.get("/api/records")
def records():
    selected_date = request.args.get("date", "").strip()
    sql = """SELECT a.id,a.session_id,a.student_id,a.status,a.marked_at,a.source,
        st.name,st.roll_no,se.subject FROM attendance a
        JOIN students st ON st.id=a.student_id
        JOIN sessions se ON se.id=a.session_id"""
    args = []
    if selected_date:
        try:
            date.fromisoformat(selected_date)
        except ValueError:
            return jsonify(error="Date must use YYYY-MM-DD."), 400
        sql += " WHERE date(a.marked_at)=?"
        args.append(selected_date)
    sql += " ORDER BY a.marked_at DESC"
    return jsonify([dict(row) for row in db().execute(sql, args).fetchall()])


@app.post("/api/manual")
def manual_mark():
    data = request.get_json(silent=True) or {}
    try:
        session_id = int(data["session_id"])
        student_id = int(data["student_id"])
        status = data["status"]
        if status not in ("present", "absent"):
            raise ValueError
        db().execute(
            """INSERT INTO attendance(client_uuid,session_id,student_id,status,marked_at,source)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(session_id,student_id) DO UPDATE SET
            status=excluded.status, marked_at=excluded.marked_at, source='manual'""",
            (str(uuid.uuid4()), session_id, student_id, status,
             datetime.now().isoformat(timespec="seconds"), "manual"),
        )
        db().commit()
        return jsonify(ok=True)
    except (KeyError, ValueError, TypeError):
        return jsonify(error="Invalid correction."), 400
    except sqlite3.IntegrityError:
        db().rollback()
        return jsonify(error="Student or session not found."), 404


@app.get("/export")
def export_excel():
    rows = db().execute(
        """SELECT a.marked_at AS Date, se.subject AS Subject, st.name AS Student,
        st.roll_no AS Roll_No, st.department AS Department, a.status AS Status,
        a.source AS Source FROM attendance a
        JOIN sessions se ON se.id=a.session_id
        JOIN students st ON st.id=a.student_id ORDER BY a.marked_at DESC"""
    ).fetchall()
    columns = ["Date", "Subject", "Student", "Roll_No", "Department", "Status", "Source"]
    frame = pd.DataFrame([dict(row) for row in rows], columns=columns)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        frame.to_excel(writer, index=False, sheet_name="Attendance")
    output.seek(0)
    return send_file(
        output, as_attachment=True, download_name="classvision_attendance.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
