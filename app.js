import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// Word pool grows with level: level N unlocks words of difficulty <= N.
const LEVEL_THRESHOLDS = [0, 12, 30]; // cumulative correct answers needed for level 1, 2, 3
const MAX_LEVEL = LEVEL_THRESHOLDS.length;

function ageBonusFor(age) {
  if (age >= 10) return 15;
  if (age >= 7) return 6;
  return 0;
}

function levelForCorrect(effectiveCorrect) {
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (effectiveCorrect >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return Math.min(level, MAX_LEVEL);
}

function usernameKey(name) {
  return name.trim().toLowerCase();
}

function randomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return Array.from(window.crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Firebase signs the user in the instant createUserWithEmailAndPassword
// resolves, which can fire onAuthStateChanged before the profile doc
// below finishes writing. This flag tells that listener to stand back
// while signUp() is driving the flow itself, so it never mistakes a
// brand-new user for one with a missing profile and signs them back out.
let signingUp = false;

async function signUp(name, age, password) {
  const key = usernameKey(name);
  if (!key) throw new Error("נא להזין שם");

  const usernameRef = doc(db, "usernames", key);
  const existing = await getDoc(usernameRef);
  if (existing.exists()) throw new Error("השם הזה תפוס, נסה שם אחר");

  const email = `${randomId()}@word-game.local`;
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const uid = credential.user.uid;

  await setDoc(usernameRef, { uid, email });
  const profile = {
    name: name.trim(),
    age,
    ageBonus: ageBonusFor(age),
    totalCorrect: 0,
    totalWrong: 0,
  };
  await setDoc(doc(db, "users", uid), { ...profile, createdAt: serverTimestamp() });

  currentUid = uid;
  currentProfile = profile;
  enterGame(profile);
}

async function logIn(name, password) {
  const key = usernameKey(name);
  const usernameSnap = await getDoc(doc(db, "usernames", key));
  if (!usernameSnap.exists()) throw new Error("משתמש לא נמצא");
  await signInWithEmailAndPassword(auth, usernameSnap.data().email, password);
}

async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function recordAnswer(uid, isCorrect) {
  updateDoc(doc(db, "users", uid), {
    totalCorrect: increment(isCorrect ? 1 : 0),
    totalWrong: increment(isCorrect ? 0 : 1),
  }).catch((err) => console.error("Failed to sync stats", err));

  setDoc(
    doc(db, "users", uid, "dailyStats", todayKey()),
    { correct: increment(isCorrect ? 1 : 0), wrong: increment(isCorrect ? 0 : 1) },
    { merge: true }
  ).catch((err) => console.error("Failed to sync daily stats", err));
}

function recordQuizCompleted(uid) {
  setDoc(
    doc(db, "users", uid, "dailyStats", todayKey()),
    { quizzes: increment(1) },
    { merge: true }
  ).catch((err) => console.error("Failed to sync quiz count", err));
}

// ---- Auth UI wiring ----

const authEls = {
  screen: document.getElementById("authScreen"),
  tabLogin: document.getElementById("tabLogin"),
  tabSignup: document.getElementById("tabSignup"),
  loginForm: document.getElementById("loginForm"),
  signupForm: document.getElementById("signupForm"),
  loginName: document.getElementById("loginName"),
  loginPassword: document.getElementById("loginPassword"),
  signupName: document.getElementById("signupName"),
  signupAge: document.getElementById("signupAge"),
  signupPassword: document.getElementById("signupPassword"),
  signupConfirm: document.getElementById("signupConfirm"),
  error: document.getElementById("authError"),
  loading: document.getElementById("authLoading"),
  userBar: document.getElementById("userBar"),
  gameStats: document.getElementById("gameStats"),
  userGreeting: document.getElementById("userGreeting"),
  userLevelBadge: document.getElementById("userLevelBadge"),
  logoutBtn: document.getElementById("logoutBtn"),
  game: document.getElementById("game"),
  celebration: document.getElementById("celebration"),
};

function setAuthError(message) {
  authEls.error.textContent = message || "";
}

function setAuthLoading(isLoading) {
  authEls.loading.classList.toggle("hidden", !isLoading);
}

authEls.tabLogin.addEventListener("click", () => {
  authEls.tabLogin.classList.add("active");
  authEls.tabSignup.classList.remove("active");
  authEls.loginForm.classList.remove("hidden");
  authEls.signupForm.classList.add("hidden");
  setAuthError("");
});

authEls.tabSignup.addEventListener("click", () => {
  authEls.tabSignup.classList.add("active");
  authEls.tabLogin.classList.remove("active");
  authEls.signupForm.classList.remove("hidden");
  authEls.loginForm.classList.add("hidden");
  setAuthError("");
});

authEls.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError("");
  setAuthLoading(true);
  try {
    await logIn(authEls.loginName.value, authEls.loginPassword.value);
  } catch (err) {
    setAuthError(loginErrorMessage(err));
  } finally {
    setAuthLoading(false);
  }
});

authEls.signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError("");

  const name = authEls.signupName.value;
  const age = Number(authEls.signupAge.value);
  const password = authEls.signupPassword.value;
  const confirm = authEls.signupConfirm.value;

  if (password !== confirm) {
    setAuthError("הסיסמאות לא תואמות");
    return;
  }
  if (password.length < 6) {
    setAuthError("הסיסמה חייבת לפחות 6 תווים");
    return;
  }

  signingUp = true;
  setAuthLoading(true);
  try {
    await signUp(name, age, password);
  } catch (err) {
    setAuthError(signupErrorMessage(err));
  } finally {
    setAuthLoading(false);
    signingUp = false;
  }
});

authEls.logoutBtn.addEventListener("click", () => signOut(auth));

function loginErrorMessage(err) {
  if (err.message === "משתמש לא נמצא") return err.message;
  if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
    return "סיסמה שגויה";
  }
  return "משהו השתבש, נסה שוב";
}

function signupErrorMessage(err) {
  if (err.message && !err.code) return err.message;
  if (err.code === "auth/weak-password") return "הסיסמה חייבת לפחות 6 תווים";
  return "משהו השתבש, נסה שוב";
}

let currentUid = null;
let currentProfile = null;

onAuthStateChanged(auth, async (user) => {
  if (signingUp) return;

  if (user) {
    if (user.uid === currentUid) return;
    setAuthLoading(true);
    try {
      const profile = await loadProfile(user.uid);
      if (!profile) {
        await signOut(auth);
        return;
      }
      currentUid = user.uid;
      currentProfile = profile;
      enterGame(profile);
    } catch (err) {
      console.error(err);
      setAuthError("משהו השתבש, נסה שוב");
    } finally {
      setAuthLoading(false);
    }
  } else {
    currentUid = null;
    currentProfile = null;
    authEls.screen.classList.remove("hidden");
    authEls.game.classList.add("hidden");
    authEls.celebration.classList.add("hidden");
    authEls.userBar.classList.add("hidden");
    authEls.gameStats.classList.add("hidden");
  }
});

function currentLevel() {
  if (!currentProfile) return 1;
  return levelForCorrect(currentProfile.totalCorrect + currentProfile.ageBonus);
}

function enterGame(profile) {
  authEls.screen.classList.add("hidden");
  authEls.game.classList.remove("hidden");
  authEls.userBar.classList.remove("hidden");
  authEls.gameStats.classList.remove("hidden");
  authEls.userGreeting.textContent = `היי ${profile.name}!`;
  authEls.userLevelBadge.textContent = `רמה ${currentLevel()}`;
  startSession();
}

// ---- Game logic ----

const gameEls = {
  score: document.getElementById("score"),
  streak: document.getElementById("streak"),
  prompt: document.getElementById("prompt"),
  options: document.getElementById("options"),
  feedback: document.getElementById("feedback"),
  game: document.getElementById("game"),
  celebration: document.getElementById("celebration"),
  celebrationScore: document.getElementById("celebrationScore"),
  confettiLayer: document.getElementById("confettiLayer"),
  playAgainBtn: document.getElementById("playAgainBtn"),
};

const CONFETTI_EMOJI = ["🎉", "⭐", "🎈", "🏅", "✨"];
const ROUNDS_PER_SESSION = 10;
const CORRECT_ADVANCE_DELAY = 900;

// Each round shows the word in one form and asks the kid to pick its
// match in a different form, so a picture is never shown alongside the
// English word it would give away.
const ROUND_TYPES = [
  { prompt: "en", options: "he" },
  { prompt: "he", options: "en" },
  { prompt: "emoji", options: "en" },
  { prompt: "en", options: "emoji" },
];

let score = 0;
let streak = 0;
let round = 0;
let lastWordEn = null;
let locked = false;

function optionKey(word, kind) {
  return kind === "he" ? word.he : kind === "en" ? word.en : word.emoji;
}

function pickRandom(array, count) {
  const pool = [...array];
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function renderPrompt(word, kind) {
  gameEls.prompt.className = `prompt kind-${kind}`;
  gameEls.prompt.textContent = optionKey(word, kind);
}

function renderOption(word, kind) {
  const btn = document.createElement("button");
  btn.className = "option-btn" + (kind === "en" ? " lang-en" : kind === "emoji" ? " emoji-option" : "");
  btn.textContent = optionKey(word, kind);
  btn.dataset.key = optionKey(word, kind);
  return btn;
}

function eligibleWords() {
  const level = currentLevel();
  const pool = window.WORDS.filter((w) => w.difficulty <= level);
  return pool.length >= 3 ? pool : window.WORDS;
}

function startSession() {
  score = 0;
  streak = 0;
  round = 0;
  gameEls.score.textContent = "0";
  gameEls.streak.textContent = "0";
  gameEls.celebration.classList.add("hidden");
  gameEls.game.classList.remove("hidden");
  nextRound();
}

function nextRound() {
  round += 1;
  if (round > ROUNDS_PER_SESSION) {
    showCelebration();
    return;
  }

  locked = false;
  gameEls.feedback.textContent = "";
  gameEls.feedback.className = "feedback";

  const pool = eligibleWords();
  let correctWord;
  do {
    correctWord = pool[Math.floor(Math.random() * pool.length)];
  } while (correctWord.en === lastWordEn && pool.length > 1);
  lastWordEn = correctWord.en;

  const roundType = ROUND_TYPES[Math.floor(Math.random() * ROUND_TYPES.length)];

  renderPrompt(correctWord, roundType.prompt);

  const correctKey = optionKey(correctWord, roundType.options);
  const wrongPool = pool.filter((w) => optionKey(w, roundType.options) !== correctKey);
  const optionWords = shuffle([correctWord, ...pickRandom(wrongPool, 2)]);

  gameEls.options.innerHTML = "";
  optionWords.forEach((word) => {
    const btn = renderOption(word, roundType.options);
    btn.addEventListener("click", () => selectOption(btn, correctKey));
    gameEls.options.appendChild(btn);
  });
}

function selectOption(button, correctKey) {
  if (locked) return;
  locked = true;

  const buttons = [...gameEls.options.children];
  const isCorrect = button.dataset.key === correctKey;

  if (isCorrect) {
    button.classList.add("correct");
    score += 1;
    streak += 1;
    gameEls.feedback.textContent = "יפה מאוד! 🎉";
    gameEls.feedback.className = "feedback show correct";
  } else {
    button.classList.add("wrong");
    streak = 0;
    gameEls.feedback.textContent = `לא נכון, התשובה היא ${correctKey}`;
    gameEls.feedback.className = "feedback show wrong";
    buttons.find((b) => b.dataset.key === correctKey)?.classList.add("correct");
  }

  gameEls.score.textContent = score;
  gameEls.streak.textContent = streak;
  buttons.forEach((b) => (b.disabled = true));

  if (currentProfile) {
    currentProfile.totalCorrect += isCorrect ? 1 : 0;
    currentProfile.totalWrong += isCorrect ? 0 : 1;
    authEls.userLevelBadge.textContent = `רמה ${currentLevel()}`;
    recordAnswer(currentUid, isCorrect);
  }

  setTimeout(nextRound, isCorrect ? CORRECT_ADVANCE_DELAY : CORRECT_ADVANCE_DELAY + 700);
}

function showCelebration() {
  gameEls.game.classList.add("hidden");
  gameEls.celebration.classList.remove("hidden");
  gameEls.celebrationScore.textContent = `${score} מתוך ${ROUNDS_PER_SESSION}`;

  if (currentUid) recordQuizCompleted(currentUid);

  gameEls.confettiLayer.innerHTML = "";
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.textContent = CONFETTI_EMOJI[Math.floor(Math.random() * CONFETTI_EMOJI.length)];
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.animationDelay = `${Math.random() * 2}s`;
    piece.style.animationDuration = `${2.6 + Math.random() * 1.6}s`;
    gameEls.confettiLayer.appendChild(piece);
  }
}

gameEls.playAgainBtn.addEventListener("click", startSession);
