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
    showScreen("auth");
    authEls.userBar.classList.add("hidden");
    authEls.gameStats.classList.add("hidden");
  }
});

function currentLevel() {
  if (!currentProfile) return 1;
  return levelForCorrect(currentProfile.totalCorrect + currentProfile.ageBonus);
}

function enterGame(profile) {
  authEls.userBar.classList.remove("hidden");
  authEls.gameStats.classList.remove("hidden");
  authEls.userGreeting.textContent = `היי ${profile.name}!`;
  authEls.userLevelBadge.textContent = `רמה ${currentLevel()}`;
  showScreen("mode");
}

// ---- Screen navigation ----

const gameEls = {
  score: document.getElementById("score"),
  streak: document.getElementById("streak"),
  prompt: document.getElementById("prompt"),
  modeBackBtn: document.getElementById("modeBackBtn"),
  hintBtn: document.getElementById("hintBtn"),
  hintReveal: document.getElementById("hintReveal"),
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
  nextBtn: document.getElementById("nextBtn"),
  game: document.getElementById("game"),
  celebration: document.getElementById("celebration"),
  celebrationScore: document.getElementById("celebrationScore"),
  confettiLayer: document.getElementById("confettiLayer"),
  playAgainBtn: document.getElementById("playAgainBtn"),
  switchModeBtn: document.getElementById("switchModeBtn"),
  modeScreen: document.getElementById("modeScreen"),
  modeContinuousBtn: document.getElementById("modeContinuousBtn"),
  modeSprintBtn: document.getElementById("modeSprintBtn"),
  modePhotoBtn: document.getElementById("modePhotoBtn"),
  photoInput: document.getElementById("photoInput"),
  photoStatus: document.getElementById("photoStatus"),
  photoConfigScreen: document.getElementById("photoConfigScreen"),
  photoConfigStartBtn: document.getElementById("photoConfigStartBtn"),
};

const screens = {
  auth: authEls.screen,
  mode: gameEls.modeScreen,
  photoConfig: gameEls.photoConfigScreen,
  game: gameEls.game,
  celebration: gameEls.celebration,
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
}

// ---- Game engine shared by all three modes ----

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

const SPRINT_WORD_COUNT = 10;
const SPRINT_STAGES = ["choice", "type", "handwrite"];

let currentMode = "continuous"; // "continuous" | "sprint" | "photo"
let score = 0;
let streak = 0;
let round = 0;
let advanceTimer = null;
let lastWordEn = null;
let locked = false;

// Photo mode: the word list/round shape/answer method are all fixed
// by the picker screen rather than chosen randomly each round.
let activeWords = null;
let activeRoundTypes = null;
let forcedAnswerMode = null;
let pendingPhotoWords = null;

// Sprint mode: 10 words, each tracked through 3 mastery stages.
let sprintWords = [];

// The round currently on screen — read by the hint button and by the
// answer-checking functions, set once per round by renderRound().
let currentCorrectWord = null;
let currentRoundType = null;
let currentAnswerMode = null;
let currentCorrectKey = null;
let hintUsedThisRound = false;

function optionKey(word, kind) {
  return kind === "he" ? word.he : kind === "en" ? word.en : word.emoji;
}

function answerLanguage(roundType) {
  return roundType.options === "he" ? "he" : "en";
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

function currentPool() {
  return activeWords || eligibleWords();
}

// A typed/handwritten answer isn't offered when the target is a
// picture (there's nothing to spell). Multiple-choice stays the most
// common mode otherwise so younger kids still get the scaffolding.
function pickAnswerMode(roundType) {
  if (roundType.options === "emoji") return "choice";
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

function renderRound(correctWord, roundType, answerMode) {
  currentCorrectWord = correctWord;
  currentRoundType = roundType;
  currentAnswerMode = answerMode;
  currentCorrectKey = optionKey(correctWord, roundType.options);
  hintUsedThisRound = false;
  gameEls.hintBtn.disabled = false;
  gameEls.hintReveal.classList.add("hidden");
  gameEls.hintReveal.textContent = "";

  locked = false;
  gameEls.feedback.textContent = "";
  gameEls.feedback.className = "feedback";
  hideAllAnswerModes();
  resetTypeInput();
  resetHandwriteCanvas();

  renderPrompt(correctWord, roundType.prompt);

  if (answerMode === "choice") {
    gameEls.options.classList.remove("hidden");
    const sourcePool = currentPool();
    const wrongPool = sourcePool.filter((w) => optionKey(w, roundType.options) !== currentCorrectKey);
    const optionWords = shuffle([correctWord, ...pickRandom(wrongPool, 2)]);
    gameEls.options.innerHTML = "";
    optionWords.forEach((word) => {
      const btn = renderOption(word, roundType.options);
      btn.addEventListener("click", () => selectOption(btn, word));
      gameEls.options.appendChild(btn);
    });
  } else if (answerMode === "type") {
    const lang = answerLanguage(roundType);
    gameEls.typeInput.dir = lang === "he" ? "rtl" : "ltr";
    gameEls.typeInput.placeholder = lang === "he" ? "הקלד בעברית" : "הקלד באנגלית";
    buildTapKeyboard(lang);
    gameEls.typeAnswer.classList.remove("hidden");
    gameEls.typeInput.focus();
  } else {
    gameEls.handwriteAnswer.classList.remove("hidden");
  }
}

// ---- Mode: continuous ----

function startSession() {
  score = 0;
  streak = 0;
  round = 0;
  lastWordEn = null;
  gameEls.score.textContent = "0";
  gameEls.streak.textContent = "0";
  nextRound();
}

// ---- Mode: sprint ----

function startSprintSession() {
  const pool = eligibleWords();
  const chosen = pickRandom(pool, Math.min(SPRINT_WORD_COUNT, pool.length));
  sprintWords = chosen.map((word) => ({ word, stage: 0 }));

  score = 0;
  streak = 0;
  lastWordEn = null;
  gameEls.score.textContent = "0";
  gameEls.streak.textContent = "0";
  nextRound();
}

function allSprintWordsMastered() {
  return sprintWords.every((entry) => entry.stage >= SPRINT_STAGES.length);
}

function pickSprintRound() {
  const remaining = sprintWords.filter((entry) => entry.stage < SPRINT_STAGES.length);
  const entry = remaining[Math.floor(Math.random() * remaining.length)];
  const answerMode = SPRINT_STAGES[entry.stage];
  const roundType = { prompt: Math.random() < 0.5 ? "he" : "emoji", options: "en" };
  return { correctWord: entry.word, roundType, answerMode };
}

function advanceSprintWord(word, succeeded) {
  const entry = sprintWords.find((e) => e.word === word);
  if (entry && succeeded) entry.stage += 1;
}

// ---- Round dispatch ----

function nextRound() {
  clearTimeout(advanceTimer);
  gameEls.nextBtn.classList.add("hidden");

  if (currentMode === "sprint") {
    if (allSprintWordsMastered()) {
      showCelebration();
      return;
    }
    const { correctWord, roundType, answerMode } = pickSprintRound();
    renderRound(correctWord, roundType, answerMode);
    return;
  }

  round += 1;
  if (round > ROUNDS_PER_SESSION) {
    showCelebration();
    return;
  }

  const pool = currentPool();
  let correctWord;
  do {
    correctWord = pool[Math.floor(Math.random() * pool.length)];
  } while (correctWord.en === lastWordEn && pool.length > 1);
  lastWordEn = correctWord.en;

  const types = activeRoundTypes || ROUND_TYPES;
  const roundType = types[Math.floor(Math.random() * types.length)];
  const answerMode = forcedAnswerMode || pickAnswerMode(roundType);

  renderRound(correctWord, roundType, answerMode);
}

// ---- Finishing a round: scoring, mistake explanations, hint penalty ----

function describeMistake(detail) {
  const correct = currentCorrectWord;
  const kind = currentRoundType.options;

  if (detail.chosenWord) {
    const chosen = detail.chosenWord;
    if (kind === "he") {
      return `לא נכון. '${chosen.he}' זה '${chosen.en}', אבל המילה המבוקשת היא '${correct.en}' שזה '${correct.he}'.`;
    }
    if (kind === "en") {
      return `לא נכון. '${chosen.en}' זה '${chosen.he}', אבל המילה המבוקשת היא '${correct.he}' וזה '${correct.en}'.`;
    }
    return `לא נכון. בחרת בתמונה של '${chosen.en}' (${chosen.he}), אבל המילה הנכונה היא '${correct.en}' (${correct.he}).`;
  }

  if (typeof detail.typedValue === "string") {
    return `כתבת '${detail.typedValue}', אבל התשובה הנכונה היא '${currentCorrectKey}'.`;
  }

  if (typeof detail.recognizedText === "string") {
    return detail.recognizedText
      ? `קראתי '${detail.recognizedText}', אבל התשובה הנכונה היא '${currentCorrectKey}'.`
      : `לא הצלחתי לקרוא את הכתב, התשובה הנכונה היא '${currentCorrectKey}'.`;
  }

  return `לא נכון, התשובה היא '${currentCorrectKey}'`;
}

function finishRound(isCorrect, detail) {
  // A hint makes the round easier, so a correct answer after using one
  // doesn't count toward score, level, daily stats, or sprint progress.
  const outcome = !isCorrect ? "wrong" : hintUsedThisRound ? "hinted" : "correct";

  if (outcome === "correct") {
    score += 1;
    streak += 1;
    gameEls.feedback.textContent = "יפה מאוד! 🎉";
    gameEls.feedback.className = "feedback show correct";
  } else if (outcome === "hinted") {
    streak = 0;
    gameEls.feedback.textContent = "נכון! אבל זה לא נספר כי השתמשת ברמז 💡";
    gameEls.feedback.className = "feedback show correct";
  } else {
    streak = 0;
    gameEls.feedback.textContent = describeMistake(detail);
    gameEls.feedback.className = "feedback show wrong";
  }

  gameEls.score.textContent = score;
  gameEls.streak.textContent = streak;

  if (currentProfile && outcome !== "hinted") {
    const countedCorrect = outcome === "correct";
    currentProfile.totalCorrect += countedCorrect ? 1 : 0;
    currentProfile.totalWrong += countedCorrect ? 0 : 1;
    authEls.userLevelBadge.textContent = `רמה ${currentLevel()}`;
    recordAnswer(currentUid, countedCorrect);
  }

  if (currentMode === "sprint") {
    advanceSprintWord(currentCorrectWord, outcome === "correct");
  }

  // A wrong answer waits for the kid to tap "next" so there's time to
  // actually read the mistake explanation; a correct one auto-advances.
  if (outcome === "wrong") {
    gameEls.nextBtn.classList.remove("hidden");
  } else {
    advanceTimer = setTimeout(nextRound, CORRECT_ADVANCE_DELAY);
  }
}

function selectOption(button, word) {
  if (locked) return;
  locked = true;

  const buttons = [...gameEls.options.children];
  const chosenKey = optionKey(word, currentRoundType.options);
  const isCorrect = chosenKey === currentCorrectKey;
  button.classList.add(isCorrect ? "correct" : "wrong");
  if (!isCorrect) buttons.find((b) => b.dataset.key === currentCorrectKey)?.classList.add("correct");
  buttons.forEach((b) => (b.disabled = true));

  finishRound(isCorrect, { chosenWord: word });
}

function checkTypedAnswer() {
  if (locked) return;
  const value = gameEls.typeInput.value.trim().toLowerCase();
  if (!value) return;
  locked = true;

  const isCorrect = value === currentCorrectKey.toLowerCase();
  gameEls.typeInput.classList.add(isCorrect ? "correct" : "wrong");
  gameEls.typeInput.disabled = true;

  finishRound(isCorrect, { typedValue: value });
}

// Edit distance, used both to forgive small handwriting-recognition
// slips and (via toleranceFor) scaled to word length.
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

function toleranceFor(word) {
  return word.length >= 5 ? 2 : 1;
}

// Upscales and binarizes the canvas (pure black ink on pure white)
// before OCR — this is a plain Canvas-pixel operation, so it carries
// none of the risk of depending on a Tesseract.js API detail we can't
// verify here, while still meaningfully helping recognition of a
// single handwritten word.
function preprocessForOcr(canvas) {
  const scale = 2;
  const out = document.createElement("canvas");
  out.width = canvas.width * scale;
  out.height = canvas.height * scale;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);

  const imageData = ctx.getImageData(0, 0, out.width, out.height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = (d[i] + d[i + 1] + d[i + 2]) / 3;
    const v = gray > 200 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return out;
}

// The canvas only ever holds one word, so instead of stripping
// non-letter characters (which can weld unrelated OCR fragments
// together into a garbled string), take the single longest run of
// letters in the right script and grade against that.
function longestLetterRun(text, lang) {
  const pattern = lang === "he" ? new RegExp("[\\u0590-\\u05FF]+", "g") : /[a-zA-Z]+/g;
  const matches = text.match(pattern) || [];
  return matches.reduce((longest, m) => (m.length > longest.length ? m : longest), "");
}

async function checkHandwriteAnswer() {
  if (locked) return;
  locked = true;
  gameEls.handwriteCheck.disabled = true;
  gameEls.handwriteRecognized.textContent = "קורא...";

  const lang = answerLanguage(currentRoundType);
  const tessLang = lang === "he" ? "heb" : "eng";
  const processed = preprocessForOcr(gameEls.handwriteCanvas);

  let recognizedText = "";
  try {
    const result = await window.Tesseract.recognize(processed, tessLang);
    recognizedText = (result.data.text || "").trim();
  } catch (err) {
    console.error("Handwriting OCR failed", err);
  }

  const cleaned = longestLetterRun(recognizedText, lang).toLowerCase();
  const target = currentCorrectKey.toLowerCase();
  const isCorrect = cleaned.length > 0 && levenshtein(cleaned, target) <= toleranceFor(target);
  gameEls.handwriteRecognized.textContent = recognizedText ? `קראתי: ${recognizedText}` : "לא הצלחתי לקרוא";

  finishRound(isCorrect, { recognizedText });
}

function showCelebration() {
  showScreen("celebration");
  gameEls.celebrationScore.textContent =
    currentMode === "sprint" ? `10 מילים הושלמו! ⭐ ${score}` : `${score} מתוך ${ROUNDS_PER_SESSION}`;

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

gameEls.playAgainBtn.addEventListener("click", () => {
  showScreen("game");
  if (currentMode === "sprint") startSprintSession();
  else startSession();
});

function goToModeSelect() {
  clearTimeout(advanceTimer);
  activeWords = null;
  activeRoundTypes = null;
  forcedAnswerMode = null;
  showScreen("mode");
}

gameEls.switchModeBtn.addEventListener("click", goToModeSelect);
gameEls.modeBackBtn.addEventListener("click", goToModeSelect);

gameEls.nextBtn.addEventListener("click", nextRound);

// ---- Mode picker ----

gameEls.modeContinuousBtn.addEventListener("click", () => {
  currentMode = "continuous";
  activeWords = null;
  activeRoundTypes = null;
  forcedAnswerMode = null;
  showScreen("game");
  startSession();
});

gameEls.modeSprintBtn.addEventListener("click", () => {
  currentMode = "sprint";
  activeWords = null;
  activeRoundTypes = null;
  forcedAnswerMode = null;
  showScreen("game");
  startSprintSession();
});

gameEls.modePhotoBtn.addEventListener("click", () => gameEls.photoInput.click());

// ---- Hint (elimination / reveal-to-copy / pronunciation) ----

function speakWord(text) {
  if (!window.speechSynthesis) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.error("Speech synthesis failed", err);
  }
}

function useHint() {
  if (hintUsedThisRound || locked) return;
  hintUsedThisRound = true;
  gameEls.hintBtn.disabled = true;

  speakWord(currentCorrectWord.en);

  if (currentAnswerMode === "choice") {
    const wrongButtons = [...gameEls.options.children].filter(
      (b) => b.dataset.key !== currentCorrectKey && !b.disabled
    );
    const pick = wrongButtons[Math.floor(Math.random() * wrongButtons.length)];
    if (pick) {
      pick.disabled = true;
      pick.classList.add("eliminated");
    }
  } else {
    gameEls.hintReveal.dir = answerLanguage(currentRoundType) === "he" ? "rtl" : "ltr";
    gameEls.hintReveal.textContent = currentCorrectKey;
    gameEls.hintReveal.classList.remove("hidden");
  }
}

gameEls.hintBtn.addEventListener("click", useHint);

// ---- Typed-answer keyboard (device keyboard works too) ----

const KEYBOARD_LAYOUTS = {
  en: ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
  he: ["אבגדהוז", "חטיכךלמ", "םנןסעפף", "צץקרשת"],
};

function buildTapKeyboard(lang) {
  gameEls.tapKeyboard.innerHTML = "";
  gameEls.tapKeyboard.dir = lang === "he" ? "rtl" : "ltr";
  KEYBOARD_LAYOUTS[lang].forEach((row) => {
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

gameEls.typeBackspace.addEventListener("click", () => {
  gameEls.typeInput.value = gameEls.typeInput.value.slice(0, -1);
  gameEls.typeInput.focus();
});

gameEls.typeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    checkTypedAnswer();
  }
});

gameEls.typeCheck.addEventListener("click", checkTypedAnswer);

// ---- Handwriting canvas (finger or mouse) ----

const handwriteCtx = gameEls.handwriteCanvas.getContext("2d");
handwriteCtx.strokeStyle = "#2b2140";
handwriteCtx.lineWidth = 9;
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

gameEls.handwriteCheck.addEventListener("click", checkHandwriteAnswer);

// ---- Photo training: read a page, quiz only on its words ----

gameEls.photoInput.addEventListener("change", async () => {
  const file = gameEls.photoInput.files[0];
  gameEls.photoInput.value = "";
  if (file) await resolvePhotoWords(file);
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

async function resolvePhotoWords(file) {
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

  pendingPhotoWords = resolved;
  setPhotoStatus("");
  showScreen("photoConfig");
}

gameEls.photoConfigStartBtn.addEventListener("click", () => {
  const direction = document.querySelector('input[name="photoDirection"]:checked').value;
  const answerModeChoice = document.querySelector('input[name="photoAnswerMode"]:checked').value;

  activeWords = pendingPhotoWords;
  activeRoundTypes =
    direction === "he-en" ? [{ prompt: "he", options: "en" }] : [{ prompt: "en", options: "he" }];
  forcedAnswerMode = answerModeChoice;
  currentMode = "photo";

  showScreen("game");
  startSession();
});
