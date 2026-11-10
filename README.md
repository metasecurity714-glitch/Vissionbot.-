# ClassVision

Minimal Flask face-attendance prototype for personal/local testing.

## Folder structure

```text
ClassVision/
├── app.py
├── requirements.txt
├── README.md
├── classvision.db             # created by running seed.py
├── schema/
│   ├── schema.sql
│   └── seed.py
├── templates/
│   ├── base.html
│   ├── students.html
│   ├── kiosk.html
│   └── dashboard.html
└── static/
    ├── app.js
    ├── style.css
    ├── face-api.min.js
    └── models/
        ├── tiny_face_detector_model-weights_manifest.json
        ├── tiny_face_detector_model-shard1
        ├── face_landmark_68_tiny_model-weights_manifest.json
        ├── face_landmark_68_tiny_model-shard1
        ├── face_recognition_model-weights_manifest.json
        └── face_recognition_model-shard1
```

## Run locally

Python 3.10+ is recommended.

```bash
cd ClassVision
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate
pip install -r requirements.txt
```

Download face-api.js and model weights (one-time internet connection):

```bash
mkdir -p static/models
curl -L https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js -o static/face-api.min.js
cd static/models
curl -L https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/tiny_face_detector_model-weights_manifest.json -o tiny_face_detector_model-weights_manifest.json
curl -L https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/tiny_face_detector_model-shard1 -o tiny_face_detector_model-shard1
curl -L https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_landmark_68_tiny_model-weights_manifest.json -o face_landmark_68_tiny_model-weights_manifest.json
curl -L https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_landmark_68_tiny_model-shard1 -o face_landmark_68_tiny_model-shard1
curl -L https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-weights_manifest.json -o face_recognition_model-weights_manifest.json
curl -L https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/face_recognition_model-shard1 -o face_recognition_model-shard1
cd ../..
```

Then seed and run:

```bash
python schema/seed.py
python app.py
```

Open `http://127.0.0.1:5000`. Camera access works on localhost. For a phone, keep the computer and phone on the same network and use a secure tunnel such as:

```bash
# Install ngrok, then:
ngrok http 5000
```

Open the HTTPS forwarding URL on the phone. Keep the Flask server running. Do not expose this prototype publicly; no login or authorization is implemented.

## Offline notes

- face-api.js and its model weights are served locally. After the initial download, face detection and matching run in the browser without internet.
- Attendance is written to IndexedDB first. Use **Sync Now** or reconnect; queued records then sync to SQLite. Server-side UUID and (session, student) uniqueness prevent duplicate records.
- Chart.js is loaded from a CDN, so the dashboard chart requires internet. Attendance/kiosk face recognition does not.
- Threshold defaults to 0.5. To tune it in a browser console, run `localStorage.setItem("classvisionThreshold","0.48")` (lower is stricter; higher is more permissive).

## Important prototype limitations

This is a personal-testing prototype, not a production biometric attendance system. Obtain informed consent, protect the device/database, and provide a non-biometric alternative. The app stores five 128-number descriptors and one compressed face thumbnail per student; it does not store the five capture photos. Face descriptors are biometric data. There is no authentication, encryption at rest, audit trail, liveness detection, or protection against photo/video spoofing. Do not use it for consequential attendance decisions without independent verification. If hosting over a tunnel, anyone with the URL can access the app and its student/face data.
