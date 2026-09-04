import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

function usernameKey(name) {
  return name.trim().toLowerCase();
}

async function logIn(name, password) {
  const key = usernameKey(name);
  const usernameSnap = await getDoc(doc(db, "usernames", key));
  if (!usernameSnap.exists()) throw new Error("משתמש לא נמצא");
  await signInWithEmailAndPassword(auth, usernameSnap.data().email, password);
}

const els = {
  loginScreen: document.getElementById("dashLoginScreen"),
  loginForm: document.getElementById("dashLoginForm"),
  name: document.getElementById("dashName"),
  password: document.getElementById("dashPassword"),
  error: document.getElementById("dashError"),
  loading: document.getElementById("dashLoading"),
  userBar: document.getElementById("dashUserBar"),
  logoutBtn: document.getElementById("dashLogoutBtn"),
  content: document.getElementById("dashContent"),
  denied: document.getElementById("dashDenied"),
  tableBody: document.getElementById("dashTableBody"),
};

function setError(msg) {
  els.error.textContent = msg || "";
}

function setLoading(isLoading) {
  els.loading.classList.toggle("hidden", !isLoading);
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setError("");
  setLoading(true);
  try {
    await logIn(els.name.value, els.password.value);
  } catch (err) {
    setError(err.message === "משתמש לא נמצא" ? err.message : "סיסמה שגויה או שגיאה, נסה שוב");
  } finally {
    setLoading(false);
  }
});

els.logoutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    els.loginScreen.classList.remove("hidden");
    els.content.classList.add("hidden");
    els.userBar.classList.add("hidden");
    return;
  }

  els.loginScreen.classList.add("hidden");
  els.userBar.classList.remove("hidden");
  els.content.classList.remove("hidden");
  els.denied.classList.add("hidden");
  els.tableBody.innerHTML = "";

  try {
    await renderDashboard();
  } catch (err) {
    if (err.code === "permission-denied") {
      els.denied.classList.remove("hidden");
    } else {
      console.error(err);
      setError("משהו השתבש, נסה שוב");
    }
  }
});

async function renderDashboard() {
  const usersSnap = await getDocs(collection(db, "users"));
  const rows = [];
  for (const userDoc of usersSnap.docs) {
    const u = userDoc.data();
    const dailySnap = await getDocs(
      query(collection(db, "users", userDoc.id, "dailyStats"), orderBy("__name__", "desc"), limit(14))
    );
    rows.push({
      name: u.name,
      age: u.age,
      totalCorrect: u.totalCorrect || 0,
      days: dailySnap.docs.map((d) => ({ date: d.id, ...d.data() })),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  rows.forEach((row) => els.tableBody.appendChild(renderUserRow(row)));
}

function renderUserRow(row) {
  const card = document.createElement("div");
  card.className = "user-report";

  const header = document.createElement("div");
  header.className = "user-report-header";
  const nameEl = document.createElement("span");
  nameEl.className = "user-report-name";
  nameEl.textContent = row.name;
  const metaEl = document.createElement("span");
  metaEl.className = "user-report-meta";
  metaEl.textContent = `גיל ${row.age} · סה"כ ${row.totalCorrect} תשובות נכונות`;
  header.append(nameEl, metaEl);
  card.appendChild(header);

  const days = document.createElement("div");
  days.className = "user-report-days";
  if (row.days.length === 0) {
    const empty = document.createElement("span");
    empty.className = "no-data";
    empty.textContent = "אין נתונים עדיין";
    days.appendChild(empty);
  } else {
    row.days.forEach((d) => {
      const chip = document.createElement("div");
      chip.className = "day-chip";
      const dateEl = document.createElement("span");
      dateEl.className = "day-date";
      dateEl.textContent = d.date;
      const statsEl = document.createElement("span");
      statsEl.className = "day-stats";
      statsEl.textContent = `${d.quizzes || 0} חידונים · ${d.correct || 0} נכונות`;
      chip.append(dateEl, statsEl);
      days.appendChild(chip);
    });
  }
  card.appendChild(days);
  return card;
}
