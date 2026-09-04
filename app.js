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
  typeAnswer: document.getElementById("typeAnswer"),
  typeInput: document.getElementById("typeInput"),
  tapKeyboard: document.getElementById("tapKeyboard"),
  typeBackspace: document.getElementById("typeBackspace"),
  typeCheck: document.getElementById("typeCheck"),
  handwriteAnswer: document.getElementById("handwriteAnswer"),
  handwriteCanvas: document.getElementById("handwriteCanvas"),
  handwriteRecognized: document.getElementById("handwriteRecognized"),
  handwriteClear: document.getElementById("handwriteClear"),
  handwriteCheck: document.getElementById("handwriteCheck"),
  feedback: document.getElementById("feedback"),
  game: document.getElementById("game"),
  celebration: document.getElementById("celebration"),
  celebrationScore: document.getElementById("celebrationScore"),
  confettiLayer: document.getElementById("confettiLayer"),
  playAgainBtn: document.getElementById("playAgainBtn"),
  photoBtn: document.getElementById("photoBtn"),
  photoInput: document.getElementById("photoInput"),
  photoStatus: document.getElementById("photoStatus"),
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

// Words captured from a photo have no emoji, so a photo session only
// ever uses text-to-text rounds.
const PHOTO_ROUND_TYPES = [
  { prompt: "en", options: "he" },
  { prompt: "he", options: "en" },
];

let score = 0;
let streak = 0;
let round = 0;
let lastWordEn = null;
let locked = false;

// Set during a photo-training session; cleared back to null (regular
// leveled practice) once that session's celebration screen shows.
let activeWords = null;
let activeRoundTypes = null;

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

// A typed/handwritten answer only makes sense when the expected
// answer is the English word (typing Hebrew, or "typing" a picture,
// isn't offered). Even then, multiple-choice stays the most common
// mode so younger kids still get the scaffolding.
function pickAnswerMode(roundType) {
  if (roundType.options !== "en") return "choice";
  const r = Math.random();
  if (r < 0.5) return "choice";
  if (r < 0.75) return "type";
  return "handwrite";
}

function hideAllAnswerModes() {
  gameEls.options.classList.add("hidden");
  gameEls.typeAnswer.classList.add("hidden");
  gameEls.handwriteAnswer.classList.add("hidden");
}

function resetTypeInput() {
  gameEls.typeInput.value = "";
  gameEls.typeInput.disabled = false;
  gameEls.typeInput.classList.remove("correct", "wrong");
}

function paintHandwriteCanvasWhite() {
  handwriteCtx.fillStyle = "#ffffff";
  handwriteCtx.fillRect(0, 0, gameEls.handwriteCanvas.width, gameEls.handwriteCanvas.height);
}

function resetHandwriteCanvas() {
  paintHandwriteCanvasWhite();
  gameEls.handwriteRecognized.textContent = "";
  gameEls.handwriteCheck.disabled = false;
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
  hideAllAnswerModes();
  resetTypeInput();
  resetHandwriteCanvas();

  const pool = activeWords || eligibleWords();
  let correctWord;
  do {
    correctWord = pool[Math.floor(Math.random() * pool.length)];
  } while (correctWord.en === lastWordEn && pool.length > 1);
  lastWordEn = correctWord.en;

  const types = activeRoundTypes || ROUND_TYPES;
  const roundType = types[Math.floor(Math.random() * types.length)];
  const answerMode = pickAnswerMode(roundType);

  renderPrompt(correctWord, roundType.prompt);

  const correctKey = optionKey(correctWord, roundType.options);

  if (answerMode === "choice") {
    gameEls.options.classList.remove("hidden");
    const wrongPool = pool.filter((w) => optionKey(w, roundType.options) !== correctKey);
    const optionWords = shuffle([correctWord, ...pickRandom(wrongPool, 2)]);
    gameEls.options.innerHTML = "";
    optionWords.forEach((word) => {
      const btn = renderOption(word, roundType.options);
      btn.addEventListener("click", () => selectOption(btn, correctKey));
      gameEls.options.appendChild(btn);
    });
  } else if (answerMode === "type") {
    gameEls.typeAnswer.classList.remove("hidden");
    gameEls.typeInput.focus();
    gameEls.typeCheck.onclick = () => checkTypedAnswer(correctKey);
  } else {
    gameEls.handwriteAnswer.classList.remove("hidden");
    gameEls.handwriteCheck.onclick = () => checkHandwriteAnswer(correctKey);
  }
}

function finishRound(isCorrect, correctText) {
  if (isCorrect) {
    score += 1;
    streak += 1;
    gameEls.feedback.textContent = "יפה מאוד! 🎉";
    gameEls.feedback.className = "feedback show correct";
  } else {
    streak = 0;
    gameEls.feedback.textContent = `לא נכון, התשובה היא ${correctText}`;
    gameEls.feedback.className = "feedback show wrong";
  }

  gameEls.score.textContent = score;
  gameEls.streak.textContent = streak;

  if (currentProfile) {
    currentProfile.totalCorrect += isCorrect ? 1 : 0;
    currentProfile.totalWrong += isCorrect ? 0 : 1;
    authEls.userLevelBadge.textContent = `רמה ${currentLevel()}`;
    recordAnswer(currentUid, isCorrect);
  }

  setTimeout(nextRound, isCorrect ? CORRECT_ADVANCE_DELAY : CORRECT_ADVANCE_DELAY + 700);
}

function selectOption(button, correctKey) {
  if (locked) return;
  locked = true;

  const buttons = [...gameEls.options.children];
  const isCorrect = button.dataset.key === correctKey;
  button.classList.add(isCorrect ? "correct" : "wrong");
  if (!isCorrect) buttons.find((b) => b.dataset.key === correctKey)?.classList.add("correct");
  buttons.forEach((b) => (b.disabled = true));

  finishRound(isCorrect, correctKey);
}

function checkTypedAnswer(correctKey) {
  if (locked) return;
  const value = gameEls.typeInput.value.trim().toLowerCase();
  if (!value) return;
  locked = true;

  const isCorrect = value === correctKey.toLowerCase();
  gameEls.typeInput.classList.add(isCorrect ? "correct" : "wrong");
  gameEls.typeInput.disabled = true;

  finishRound(isCorrect, correctKey);
}

// Two-letter edit distance, used to forgive small handwriting-recognition
// slips (an extra/missing/swapped letter) rather than grading purely on
// an exact match, since on-device handwriting OCR is never perfectly
// reliable.
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

async function checkHandwriteAnswer(correctKey) {
  if (locked) return;
  locked = true;
  gameEls.handwriteCheck.disabled = true;
  gameEls.handwriteRecognized.textContent = "קורא...";

  let recognizedText = "";
  try {
    const result = await window.Tesseract.recognize(gameEls.handwriteCanvas, "eng");
    recognizedText = (result.data.text || "").trim();
  } catch (err) {
    console.error("Handwriting OCR failed", err);
  }

  const cleaned = recognizedText.toLowerCase().replace(/[^a-z]/g, "");
  const target = correctKey.toLowerCase();
  const isCorrect = cleaned.length > 0 && (cleaned === target || levenshtein(cleaned, target) <= 1);
  gameEls.handwriteRecognized.textContent = recognizedText ? `קראתי: ${recognizedText}` : "לא הצלחתי לקרוא";

  finishRound(isCorrect, correctKey);
}

function showCelebration() {
  gameEls.game.classList.add("hidden");
  gameEls.celebration.classList.remove("hidden");
  gameEls.celebrationScore.textContent = `${score} מתוך ${ROUNDS_PER_SESSION}`;

  if (currentUid) recordQuizCompleted(currentUid);

  activeWords = null;
  activeRoundTypes = null;

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

// ---- Typed-answer keyboard (works alongside the device's own keyboard) ----

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function buildTapKeyboard() {
  gameEls.tapKeyboard.innerHTML = "";
  KEYBOARD_ROWS.forEach((row) => {
    [...row].forEach((letter) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "tap-key";
      key.textContent = letter;
      key.addEventListener("click", () => {
        gameEls.typeInput.value += letter;
        gameEls.typeInput.focus();
      });
      gameEls.tapKeyboard.appendChild(key);
    });
  });
}
buildTapKeyboard();

gameEls.typeBackspace.addEventListener("click", () => {
  gameEls.typeInput.value = gameEls.typeInput.value.slice(0, -1);
  gameEls.typeInput.focus();
});

gameEls.typeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    gameEls.typeCheck.click();
  }
});

// ---- Handwriting canvas (finger or mouse) ----

const handwriteCtx = gameEls.handwriteCanvas.getContext("2d");
handwriteCtx.strokeStyle = "#2b2140";
handwriteCtx.lineWidth = 6;
handwriteCtx.lineCap = "round";
handwriteCtx.lineJoin = "round";
paintHandwriteCanvasWhite();

let drawing = false;
let lastPoint = null;

function canvasPoint(e) {
  const rect = gameEls.handwriteCanvas.getBoundingClientRect();
  const scaleX = gameEls.handwriteCanvas.width / rect.width;
  const scaleY = gameEls.handwriteCanvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

gameEls.handwriteCanvas.addEventListener("pointerdown", (e) => {
  drawing = true;
  lastPoint = canvasPoint(e);
  gameEls.handwriteCanvas.setPointerCapture(e.pointerId);
});

gameEls.handwriteCanvas.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const point = canvasPoint(e);
  handwriteCtx.beginPath();
  handwriteCtx.moveTo(lastPoint.x, lastPoint.y);
  handwriteCtx.lineTo(point.x, point.y);
  handwriteCtx.stroke();
  lastPoint = point;
});

function stopDrawing() {
  drawing = false;
  lastPoint = null;
}
gameEls.handwriteCanvas.addEventListener("pointerup", stopDrawing);
gameEls.handwriteCanvas.addEventListener("pointercancel", stopDrawing);
gameEls.handwriteCanvas.addEventListener("pointerleave", stopDrawing);

gameEls.handwriteClear.addEventListener("click", () => {
  paintHandwriteCanvasWhite();
  gameEls.handwriteRecognized.textContent = "";
});

// ---- Photo training: read a page, quiz only on its words ----

gameEls.photoBtn.addEventListener("click", () => gameEls.photoInput.click());

gameEls.photoInput.addEventListener("change", async () => {
  const file = gameEls.photoInput.files[0];
  gameEls.photoInput.value = "";
  if (file) await startPhotoSession(file);
});

function setPhotoStatus(text, isError) {
  if (!text) {
    gameEls.photoStatus.classList.add("hidden");
    return;
  }
  gameEls.photoStatus.textContent = text;
  gameEls.photoStatus.classList.remove("hidden");
  gameEls.photoStatus.classList.toggle("error", Boolean(isError));
}

// Free, no-signup translation endpoint (MyMemory) — good enough for
// single common words, no billing/account setup required. Quality can
// be uneven for uncommon words since it's a community-run service.
async function translateWord(word) {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|he`
    );
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated || translated.toLowerCase() === word.toLowerCase()) return null;
    return translated;
  } catch (err) {
    console.error("Translation failed", err);
    return null;
  }
}

async function startPhotoSession(file) {
  setPhotoStatus("קורא את התמונה...");
  let text = "";
  try {
    const result = await window.Tesseract.recognize(file, "eng");
    text = result.data.text || "";
  } catch (err) {
    console.error("Photo OCR failed", err);
    setPhotoStatus("לא הצלחתי לקרוא את התמונה, נסה תמונה ברורה יותר", true);
    return;
  }

  const candidates = [...new Set((text.match(/[A-Za-z]{2,}/g) || []).map((w) => w.toLowerCase()))].slice(0, 20);
  if (candidates.length === 0) {
    setPhotoStatus("לא נמצאו מילים באנגלית בתמונה", true);
    return;
  }

  setPhotoStatus(`מתרגם ${candidates.length} מילים...`);
  const resolved = [];
  for (const word of candidates) {
    const known = window.WORDS.find((w) => w.en === word);
    if (known) {
      resolved.push(known);
      continue;
    }
    const he = await translateWord(word);
    if (he) resolved.push({ en: word, he, emoji: null, difficulty: null });
  }

  if (resolved.length < 3) {
    setPhotoStatus("לא הצלחתי למצוא מספיק מילים בתמונה, נסה תמונה אחרת", true);
    return;
  }

  activeWords = resolved;
  activeRoundTypes = PHOTO_ROUND_TYPES;
  setPhotoStatus("");
  startSession();
}
