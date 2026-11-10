const $ = (selector) => document.querySelector(selector);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// IndexedDB v2 keeps the pending attendance queue and the last known face profiles.
function openLocalDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ClassVisionOffline", 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("queue")) {
        database.createObjectStore("queue", { keyPath: "client_uuid" });
      }
      if (!database.objectStoreNames.contains("faces")) {
        database.createObjectStore("faces", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close other ClassVision tabs and reload."));
  });
}

async function storeOperation(storeName, mode, operation) {
  const database = await openLocalDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    operation(store);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { const error = transaction.error; database.close(); reject(error); };
    transaction.onabort = () => { const error = transaction.error; database.close(); reject(error); };
  });
}

async function readAll(storeName) {
  const database = await openLocalDB();
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => { const result = request.result; database.close(); resolve(result); };
    request.onerror = () => { const error = request.error; database.close(); reject(error); };
  });
}

async function queuePut(record) {
  await storeOperation("queue", "readwrite", store => store.put(record));
}
async function queueAll() { return readAll("queue"); }
async function queueClear(ids) {
  await storeOperation("queue", "readwrite", store => ids.forEach(id => store.delete(id)));
}
async function cacheFaces(faces) {
  await storeOperation("faces", "readwrite", store => {
    store.clear();
    faces.forEach(person => store.put(person));
  });
}
async function cachedFaces() { return readAll("faces"); }
async function removeCachedFace(id) {
  await storeOperation("faces", "readwrite", store => store.delete(Number(id)));
}
async function clearCachedFaces() {
  await storeOperation("faces", "readwrite", store => store.clear());
}

async function pendingCount() {
  const records = await queueAll();
  const element = $("#pending");
  if (element) element.textContent = records.length;
  return records.length;
}

const PENDING_ENDS_KEY = "classvisionPendingSessionEnds";
function pendingSessionEnds() {
  try { return JSON.parse(localStorage.getItem(PENDING_ENDS_KEY) || "[]"); }
  catch (_) { return []; }
}
function savePendingSessionEnds(ids) {
  localStorage.setItem(PENDING_ENDS_KEY, JSON.stringify(ids));
}

async function syncSessionEnds() {
  if (!navigator.onLine) return;
  const ids = pendingSessionEnds();
  const remaining = [];
  for (const id of ids) {
    try { await api(`/api/sessions/${id}/end`, { method: "POST" }); }
    catch (_) { remaining.push(id); }
  }
  savePendingSessionEnds(remaining);
}

async function syncQueue() {
  if (!navigator.onLine) {
    await pendingCount();
    return;
  }
  try {
    await syncSessionEnds();
    const records = await queueAll();
    if (records.length) {
      await api("/api/sync", { method: "POST", body: JSON.stringify({ records }) });
      // The server acknowledges the batch, including records it safely ignored as duplicates.
      await queueClear(records.map(record => record.client_uuid));
    }
    await pendingCount();
    if ($("#kioskStatus")) $("#kioskStatus").textContent = "Sync complete.";
  } catch (error) {
    if ($("#kioskStatus")) $("#kioskStatus").textContent = `Sync pending: ${error.message}`;
  }
}

function networkBadge() {
  const element = $("#network");
  if (!element) return;
  element.textContent = navigator.onLine ? "Online" : "Offline";
  element.className = `badge ${navigator.onLine ? "online" : "offline"}`;
}
window.addEventListener("online", () => { networkBadge(); syncQueue(); });
window.addEventListener("offline", networkBadge);

function makeUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loadFaceModels() {
  if (!window.faceapi) throw new Error("face-api.js is missing. Download it to static/face-api.min.js.");
  await faceapi.nets.tinyFaceDetector.loadFromUri("/static/models");
  await faceapi.nets.faceLandmark68TinyNet.loadFromUri("/static/models");
  await faceapi.nets.faceRecognitionNet.loadFromUri("/static/models");
}

async function openCamera(video) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera requires HTTPS or localhost and browser camera permission.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" }, audio: false
  });
  video.srcObject = stream;
  await new Promise((resolve, reject) => {
    if (video.readyState >= 2) return resolve();
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("Could not load camera video."));
  });
  await video.play();
  return stream;
}

async function refreshFaceCacheFromServer() {
  const faces = await api("/api/face-data");
  await cacheFaces(faces);
  return faces;
}

async function initStudents() {
  const list = $("#studentList");
  const select = $("#enrollStudent");
  if (!list || !select) return;

  async function refresh() {
    const students = await api("/api/students");
    list.replaceChildren();
    select.innerHTML = '<option value="">Choose student</option>';
    students.forEach(student => {
      const option = document.createElement("option");
      option.value = student.id;
      option.textContent = `${student.name} (${student.roll_no})`;
      select.append(option);

      const row = document.createElement("div");
      row.className = "student";
      const image = document.createElement("img");
      image.alt = `${student.name} profile thumbnail`;
      if (student.thumbnail) image.src = student.thumbnail;
      const info = document.createElement("div");
      info.className = "grow";
      const name = document.createElement("b");
      name.textContent = student.name;
      const details = document.createElement("small");
      details.textContent = `${student.roll_no} · ${student.department} · ${student.has_face ? "Face enrolled" : "No face"}`;
      info.append(name, document.createElement("br"), details);

      const reenroll = document.createElement("button");
      reenroll.className = "secondary";
      reenroll.textContent = "Re-enroll face";
      reenroll.onclick = () => {
        select.value = String(student.id);
        $("#enrollStatus").textContent = `Selected ${student.name}. Accept consent and capture five samples.`;
      };

      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "Delete";
      remove.onclick = async () => {
        if (!confirm(`Delete ${student.name} and their attendance?`)) return;
        try {
          await api(`/api/students/${student.id}`, { method: "DELETE" });
          await removeCachedFace(student.id);
          await refresh();
        } catch (error) { alert(error.message); }
      };
      row.append(image, info, reenroll, remove);
      list.append(row);
    });
  }

  $("#studentForm").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/students", {
        method: "POST", body: JSON.stringify(Object.fromEntries(form))
      });
      event.currentTarget.reset();
      $("#enrollStatus").textContent = "Student added.";
      await refresh();
    } catch (error) { alert(error.message); }
  };

  $("#deleteFaces").onclick = async () => {
    if (!confirm("Delete every stored face descriptor and profile thumbnail from the server and this browser?")) return;
    try {
      await api("/api/faces/delete-all", { method: "POST" });
      await clearCachedFaces();
      localStorage.setItem("classvisionFacesClearedAt", String(Date.now()));
      await refresh();
      $("#enrollStatus").textContent = "All face data deleted from the server and this browser.";
    } catch (error) { alert(error.message); }
  };

  await refresh();

  let stream = null;
  let samples = [];
  let thumbnail = null;
  let modelsLoaded = false;
  let capturing = false;
  const video = $("#enrollVideo");
  const captureButton = $("#captureFace");

  $("#cameraStart").onclick = async () => {
    if (!$("#consent").checked) {
      alert("Consent is required before capturing.");
      return;
    }
    if (!select.value) { alert("Choose a student first."); return; }
    try {
      if (!modelsLoaded) { await loadFaceModels(); modelsLoaded = true; }
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = await openCamera(video);
      samples = [];
      thumbnail = null;
      captureButton.disabled = false;
      captureButton.textContent = "Capture sample (0/5)";
      $("#enrollStatus").textContent = "Camera ready. Look straight, then change your head angle slightly for each sample.";
    } catch (error) { alert(`Camera/model error: ${error.message}`); }
  };

  captureButton.onclick = async () => {
    if (!$("#consent").checked) {
      alert("Consent must remain checked while capturing.");
      captureButton.disabled = true;
      return;
    }
    if (capturing || !stream || samples.length >= 5) return;
    capturing = true;
    captureButton.disabled = true;
    try {
      const result = await faceapi.detectSingleFace(
        video, new faceapi.TinyFaceDetectorOptions()
      ).withFaceLandmarks(true).withFaceDescriptor();
      if (!result) {
        $("#enrollStatus").textContent = "No face found. Adjust lighting and try again.";
        return;
      }
      if (!$("#consent").checked) {
        $("#enrollStatus").textContent = "Consent was withdrawn. No sample was saved.";
        return;
      }
      const descriptor = Array.from(result.descriptor);
      if (descriptor.length !== 128) throw new Error("Face descriptor has an unexpected length.");
      samples.push(descriptor);

      if (!thumbnail) {
        const box = result.detection.box;
        const side = Math.max(box.width, box.height) * 1.5;
        const left = Math.max(0, Math.min(video.videoWidth - side, box.x - (side - box.width) / 2));
        const top = Math.max(0, Math.min(video.videoHeight - side, box.y - (side - box.height) / 2));
        const cropWidth = Math.min(side, video.videoWidth - left);
        const cropHeight = Math.min(side, video.videoHeight - top);
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 160;
        canvas.getContext("2d").drawImage(video, left, top, cropWidth, cropHeight, 0, 0, 160, 160);
        thumbnail = canvas.toDataURL("image/jpeg", 0.55);
      }

      captureButton.textContent = `Capture sample (${samples.length}/5)`;
      if (samples.length < 5) {
        $("#enrollStatus").textContent = "Sample saved. Change your head angle slightly and capture again.";
      } else {
        $("#enrollStatus").textContent = "Five samples captured. Saving…";
        await api(`/api/students/${select.value}/face`, {
          method: "PUT", body: JSON.stringify({ descriptors: samples, thumbnail })
        });
        await refreshFaceCacheFromServer();
        $("#enrollStatus").textContent = "Face enrollment saved. One thumbnail and five descriptors are stored.";
        await refresh();
      }
    } catch (error) {
      $("#enrollStatus").textContent = error.message;
    } finally {
      capturing = false;
      captureButton.disabled = samples.length >= 5 || !stream;
    }
  };

  $("#stopCamera").onclick = () => {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    captureButton.disabled = true;
  };
}

async function initKiosk() {
  const video = $("#kioskVideo");
  if (!video) return;

  let stream = null;
  let session = null;
  let people = [];
  let totalStudents = 0;
  let markedIds = new Set();
  let streakId = null;
  let streak = 0;
  let scanning = false;
  let lastDetection = 0;
  let audioContext = null;
  let modelsLoaded = false;
  const screen = $("#recognition");
  const status = $("#kioskStatus");

  function show(kind, title, subtitle) {
    screen.className = `recognition ${kind}`;
    screen.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = title;
    const detail = document.createElement("span");
    detail.textContent = subtitle;
    screen.append(heading, detail);
  }

  function resetStreak() { streak = 0; streakId = null; }
  function distance(first, second) {
    if (!first || !second || first.length !== 128 || second.length !== 128) return Infinity;
    let sum = 0;
    for (let index = 0; index < 128; index++) {
      const delta = first[index] - second[index];
      sum += delta * delta;
    }
    return Math.sqrt(sum);
  }
  function playBeep() {
    if (!audioContext) return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.frequency.value = 880;
      gain.gain.value = 0.08;
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.16);
    } catch (_) { /* Audio is a convenience; attendance remains saved. */ }
  }

  async function detectFrame() {
    if (!scanning || video.readyState < 2) return;
    const now = performance.now();
    if (now - lastDetection < 180) return;
    lastDetection = now;
    try {
      const result = await faceapi.detectSingleFace(
        video, new faceapi.TinyFaceDetectorOptions()
      ).withFaceLandmarks(true).withFaceDescriptor();
      if (!result) {
        resetStreak();
        show("neutral", "Look at the camera", "Move into the camera frame.");
        return;
      }

      const descriptor = Array.from(result.descriptor);
      let bestPerson = null;
      let bestDistance = Infinity;
      for (const person of people) {
        for (const storedDescriptor of person.descriptors) {
          const currentDistance = distance(descriptor, storedDescriptor);
          if (currentDistance < bestDistance) {
            bestDistance = currentDistance;
            bestPerson = person;
          }
        }
      }
      const configuredThreshold = Number(localStorage.getItem("classvisionThreshold") || "0.5");
      const threshold = Number.isFinite(configuredThreshold) ? configuredThreshold : 0.5;
      if (!bestPerson || bestDistance > threshold) {
        resetStreak();
        show("bad", "Unknown face", "No enrolled student matched.");
        return;
      }

      if (streakId === bestPerson.id) streak += 1;
      else { streakId = bestPerson.id; streak = 1; }
      if (streak < 3) {
        show("neutral", "Verifying…", bestPerson.name);
        return;
      }

      if (markedIds.has(bestPerson.id)) {
        show("neutral", "Already marked", `${bestPerson.name} · ${bestPerson.roll_no}`);
        return;
      }

      const record = {
        client_uuid: makeUUID(),
        session_id: session.id,
        student_id: bestPerson.id,
        status: "present",
        marked_at: localDateTimeString(),
        source: "kiosk"
      };
      // Persist locally before attempting any network request.
      await queuePut(record);
      markedIds.add(bestPerson.id);
      $("#presentCount").textContent = markedIds.size;
      await pendingCount();
      show("good", `${bestPerson.name} · ${bestPerson.roll_no}`, "PRESENT");
      playBeep();
      if (navigator.onLine) syncQueue();
      resetStreak();
    } catch (error) {
      resetStreak();
      status.textContent = `Camera detection error: ${error.message}`;
    }
  }

  function scanLoop() {
    if (!scanning) return;
    detectFrame().finally(() => {
      if (scanning) requestAnimationFrame(scanLoop);
    });
  }

  $("#startSession").onclick = async () => {
    const subject = $("#subject").value.trim();
    if (!subject) { alert("Enter a subject name."); return; }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass && !audioContext) audioContext = new AudioContextClass();
      if (audioContext) await audioContext.resume();
      if (!modelsLoaded) { await loadFaceModels(); modelsLoaded = true; }
      try {
        people = await refreshFaceCacheFromServer();
      } catch (networkError) {
        people = await cachedFaces();
        if (!people.length) throw new Error("No cached face profiles. Connect once and enroll students before offline use.");
      }
      people = people.filter(person => Array.isArray(person.descriptors)
        && person.descriptors.length === 5
        && person.descriptors.every(descriptor => Array.isArray(descriptor) && descriptor.length === 128));
      if (!people.length) throw new Error("No valid enrolled face profiles. Enroll students first.");

      const students = await api("/api/students");
      totalStudents = students.length;
      stream = await openCamera(video);
      // Create the session while online. The active session can then continue offline.
      session = await api("/api/sessions", {
        method: "POST", body: JSON.stringify({ subject })
      });
      markedIds = new Set();
      resetStreak();
      $("#presentCount").textContent = "0";
      $("#totalCount").textContent = totalStudents;
      $("#sessionLabel").textContent = `${subject} · Session #${session.id}`;
      $("#startSession").disabled = true;
      $("#endSession").disabled = false;
      scanning = true;
      show("neutral", "Look at the camera", "Recognition is running.");
      scanLoop();
    } catch (error) {
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null;
      video.srcObject = null;
      session = null;
      if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
      status.textContent = `Could not start: ${error.message}`;
    }
  };

  window.addEventListener("storage", event => {
    if (event.key === "classvisionFacesClearedAt") {
      people = [];
      resetStreak();
      scanning = false;
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null;
      video.srcObject = null;
      $("#startSession").disabled = false;
      $("#endSession").disabled = true;
      show("bad", "Face data deleted", "Reload after enrolling face profiles again.");
    }
  });

  $("#endSession").onclick = async () => {
    scanning = false;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
    if (session) {
      if (navigator.onLine) {
        try { await api(`/api/sessions/${session.id}/end`, { method: "POST" }); }
        catch (_) {
          const pending = pendingSessionEnds();
          if (!pending.includes(session.id)) pending.push(session.id);
          savePendingSessionEnds(pending);
        }
      } else {
        const pending = pendingSessionEnds();
        if (!pending.includes(session.id)) pending.push(session.id);
        savePendingSessionEnds(pending);
      }
    }
    session = null;
    $("#startSession").disabled = false;
    $("#endSession").disabled = true;
    show("neutral", "Session ended", "Attendance is saved locally and will sync when online.");
    await pendingCount();
    if (navigator.onLine) syncQueue();
  };

  $("#syncNow").onclick = syncQueue;
  networkBadge();
  await pendingCount();
  if (navigator.onLine) syncQueue();
}

function localDateTimeString() {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function loadRecords() {
  const body = $("#recordsBody");
  if (!body) return;
  const selectedDate = $("#recordDate").value;
  const rows = await api("/api/records" + (selectedDate ? `?date=${encodeURIComponent(selectedDate)}` : ""));
  body.replaceChildren();
  rows.forEach(record => {
    const row = document.createElement("tr");
    [record.marked_at, record.subject, record.name, record.roll_no, record.status, record.source]
      .forEach(value => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });
    body.append(row);
  });
}

async function initDashboard() {
  const chartCanvas = $("#subjectChart");
  if (!chartCanvas) return;
  try {
    const data = await api("/api/dashboard");
    $("#totalStudents").textContent = data.total;
    $("#presentToday").textContent = data.present;
    $("#absentToday").textContent = data.absent;
    $("#attendancePct").textContent = `${data.percentage}%`;

    if (window.Chart) {
      if (window.classVisionChart) window.classVisionChart.destroy();
      window.classVisionChart = new Chart(chartCanvas, {
        type: "bar",
        data: {
          labels: data.subjects,
          datasets: [{
            label: "Present students", data: data.counts,
            backgroundColor: "#2775b6"
          }]
        },
        options: {
          responsive: true,
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
        }
      });
    }

    const statsBody = $("#statsBody");
    statsBody.replaceChildren();
    data.students.forEach(student => {
      const row = document.createElement("tr");
      [student.name, student.roll_no, student.department, `${student.percentage}%`]
        .forEach(value => {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        });
      row.lastElementChild.className = student.percentage < 75 ? "low" : "goodpct";
      statsBody.append(row);
    });

    const [students, sessions] = await Promise.all([api("/api/students"), api("/api/sessions")]);
    $("#manualStudent").innerHTML = students.map(student =>
      `<option value="${student.id}">${escapeHtml(student.name)} (${escapeHtml(student.roll_no)})</option>`
    ).join("");
    $("#manualSession").innerHTML = sessions.map(item =>
      `<option value="${item.id}">${escapeHtml(item.subject)} · #${item.id}</option>`
    ).join("");
    await loadRecords();
  } catch (error) {
    console.error("Dashboard loading failed:", error);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[character]));
}

document.addEventListener("DOMContentLoaded", () => {
  initStudents().catch(error => console.error("Students page:", error));
  initKiosk().catch(error => console.error("Kiosk page:", error));
  initDashboard();

  if ($("#recordDate")) {
    $("#recordDate").onchange = () => loadRecords().catch(console.error);
    $("#clearDate").onclick = () => {
      $("#recordDate").value = "";
      loadRecords().catch(console.error);
    };
  }
  if ($("#manualSave")) {
    $("#manualSave").onclick = async () => {
      try {
        await api("/api/manual", {
          method: "POST",
          body: JSON.stringify({
            session_id: $("#manualSession").value,
            student_id: $("#manualStudent").value,
            status: $("#manualStatus").value
          })
        });
        $("#manualStatusText").textContent = "Correction saved.";
        await initDashboard();
      } catch (error) {
        $("#manualStatusText").textContent = error.message;
      }
    };
  }
});
